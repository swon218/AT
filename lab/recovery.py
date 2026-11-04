"""Operator commands for reviewed candle recovery and whole-history source changes."""
import argparse
from contextlib import closing
import csv
from datetime import date, datetime
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time

from collect import collection_lock, window_start
from nightly import KIWOOM, PASS, ProviderError, completed_day, coverage, prepare_input, provider, public_version
from store import (FIELDS, KST, active_recoveries, connect, now_iso, recovery_context, save_rows,
                   validate_rows, withdraw)

SOURCES = {
    "Kiwoom ka10081 adjusted KRX": KIWOOM[0],
    "Kiwoom ka10081 adjusted SOR (_AL)": KIWOOM[1],
}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)


def csv_rows(root, name):
    with (root / name).open(encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


def key(row):
    return row["code"], row["trade_date"]


def checked_import(db, root, target, apply):
    problems = {key(r): r for r in csv_rows(root, "problem_candles.csv")}
    comparisons = {key(r): r for r in csv_rows(root, "source_comparison_recovery.csv")}
    trial = {key(r): r for r in csv_rows(root, "trial_candidate_validation.csv")}
    files = ("problem_candles.csv", "source_comparison_recovery.csv", "trial_candidate_validation.csv",
             "recovery_candidates.csv", "source_basis_and_limits.csv", "diagnostic_report.md")
    hashes = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in files}
    start = window_start(date.fromisoformat(target)).isoformat()
    seen = set()
    for record in csv_rows(root, "recovery_candidates.csv"):
        code, day = key(record)
        if (code, day) in seen or not re.fullmatch(r"[0-9][0-9A-Z]{5}", code):
            raise ValueError("Invalid or duplicate candidate")
        seen.add((code, day))
        if not start <= day <= target:
            print(json.dumps({"code": code, "date": day, "status": "outside_retention"}))
            continue
        before, comparison, fixture = problems[(code, day)], comparisons[(code, day)], trial[(code, day)]
        source = SOURCES[record["candidate_source"]]
        basis = source + ":v1"
        base = (before["provider_source"], before["raw_hash"], before["quality_policy"])
        row = {"date": day, **{k: float(record["candidate_" + k]) for k in FIELDS}}
        if (record != comparison or record["classification"] != "C" or record["candidate_valid"] != "1"
                or (record["db_source"], record["db_raw_hash"], record["db_quality_policy"]) != base
                or fixture["source"] != "RECOVERY:" + source or fixture["api_matches_candidate"] != "1"
                or any(float(fixture[k]) != row[k] for k in FIELDS) or not validate_rows([row])[0][-1]):
            raise ValueError(f"Diagnostic records disagree for {code} {day}")
        current = db.execute("SELECT source,raw_hash,policy,status FROM current_candle_quality WHERE code=? AND date=?",
                             (code, day)).fetchone()
        if current != (*base, "quarantined"):
            print(json.dumps({"code": code, "date": day, "status": "base_identity_changed"}))
            continue
        evidence = {"files": hashes, "basis_match": record["basis_match"], "trial_raw_hash": fixture["raw_hash"]}
        identity = hashlib.sha256(canonical([code, day, *base, source, basis, row, evidence]).encode()).hexdigest()
        if apply:
            db.execute("INSERT OR IGNORE INTO lab_recovery_candidates VALUES(?,?,?,?,?,?,?,?,?,?)",
                       (identity, code, day, *base, source, basis, canonical(row), canonical(evidence)))
        print(json.dumps({"candidate": identity, "code": code, "date": day, "source": source, "status": "registered" if apply else "eligible"}))
    print(json.dumps({"reconstruction_review": sorted({r["code"] for r in comparisons.values() if r["classification"] == "D"
                                                       and start <= r["trade_date"] <= target})}))


def neighbors(db, code, day, source):
    context = []
    for operator, order in (("<", "DESC"), (">", "ASC")):
        context.extend({"date": r[0], **dict(zip(FIELDS, r[1:]))} for r in db.execute(f"""
            SELECT c.date,c.open,c.high,c.low,c.close,c.volume FROM candles c
            JOIN current_candle_quality q USING(code,date)
            WHERE c.code=? AND c.date{operator}? AND q.source=? AND q.status='original' AND c.tradable=1
            ORDER BY c.date {order} LIMIT 5""", (code, day, source)))
    return sorted(context, key=lambda r: r["date"])


def approve(db, identity, target, deadline):
    candidate = db.execute("""SELECT code,date,base_source,base_hash,base_policy,source,payload,evidence
        FROM lab_recovery_candidates WHERE id=?""", (identity,)).fetchone()
    if not candidate:
        raise ValueError("Unknown candidate")
    code, day, base_source, raw_hash, policy, source, payload, evidence = candidate
    base = (base_source, raw_hash, policy, "quarantined")
    context = neighbors(db, code, day, base_source)
    current = db.execute("SELECT source,raw_hash,policy,status FROM current_candle_quality WHERE code=? AND date=?",
                         (code, day)).fetchone()
    row = json.loads(payload)
    evidence = json.loads(evidence)
    evidence.update(context=context, compared_at=now_iso(), current_identity=current, review_target=target)
    accepted = False
    if current == base and window_start(date.fromisoformat(target)).isoformat() <= day <= target and len(context) == 10:
        try:
            received = provider("prices", code, context[0]["date"], context[-1]["date"], source, deadline=deadline)
            by_day = {r["date"]: r for r in received}
            evidence["comparison"] = [by_day.get(r["date"]) for r in [*context, row]]
            accepted = len(by_day) == len(received) and all(by_day.get(r["date"]) == r for r in [*context, row])
            if not accepted:
                evidence["error"] = "reference_mismatch"
        except (ProviderError, TimeoutError, OSError, ValueError):
            evidence["error"] = "reference_unavailable"
    with db:
        db.execute("BEGIN IMMEDIATE")
        validation = db.execute("""INSERT INTO lab_recovery_validations(candidate,at,accepted,evidence)
            VALUES(?,?,?,?)""", (identity, now_iso(), accepted, canonical(evidence))).lastrowid
        if accepted:
            identity_now = db.execute("SELECT source,raw_hash,policy,status FROM current_candle_quality WHERE code=? AND date=?",
                                      (code, day)).fetchone()
            if identity_now != base or not recovery_context(db, code, evidence, base_source):
                raise ValueError("Context changed before applying")
            for old, old_day, *_ in active_recoveries(db, code):
                if old_day == day:
                    withdraw(db, code, day, old, "reviewed_replacement", "supersede")
            event = db.execute("""INSERT INTO lab_resolution_events(candidate,validation,at,action,reason)
                VALUES(?,?,?,'apply','live_source_and_context_match')""", (identity, validation, now_iso())).lastrowid
            db.execute("INSERT INTO lab_resolution_current VALUES(?,?,?)", (code, day, event))
            db.execute("INSERT OR REPLACE INTO candles VALUES(?,?,?,?,?,?,?,?)", (code, *validate_rows([row])[0]))
            refresh_quality(db, code)
            public_version(db)
    print(json.dumps({"candidate": identity, "validation": validation, "accepted": accepted}))
    return 0 if accepted else 1


def refresh_quality(db, code):
    bad = db.execute("SELECT count(*) FROM effective_candle_quality WHERE code=? AND status='quarantined'", (code,)).fetchone()[0]
    db.execute("""UPDATE symbols SET error=CASE WHEN error IS NULL OR error LIKE 'OHLC quarantine:%'
        THEN ? ELSE error END WHERE code=?""", (f"OHLC quarantine: {bad} day(s)" if bad else None, code))
    if not bad:
        db.execute("""UPDATE lab_public_symbols SET detail='recheck_required',status='pending' WHERE code=?
                      AND status='quality_failed' AND detail IN ('unresolved_price_quality','recovery_basis_changed')""", (code,))
        db.execute("UPDATE symbols SET error=NULL WHERE code=? AND error='quality_failed' AND EXISTS "
                   "(SELECT 1 FROM lab_public_symbols WHERE code=? AND detail='recheck_required')", (code, code))


def rebase(db, code, source, listed, evidence, target, deadline):
    symbol = db.execute("SELECT name,market,active FROM symbols WHERE code=?", (code,)).fetchone()
    if not symbol or not symbol[2] or date.fromisoformat(listed) > date.fromisoformat(target):
        raise ValueError("Rebase requires an active symbol and a confirmed listing date")
    start = max(window_start(date.fromisoformat(target)).isoformat(), listed)
    if (evidence.get("source") != source or evidence.get("listed") != listed
            or not all(isinstance(evidence.get(k), str) and evidence[k].strip()
                       for k in ("reviewer", "listing_reference", "adjustment_reference", "volume_reference", "session_reference"))
            or not isinstance(evidence.get("reference_rows"), list)):
        raise ValueError("Rebase requires reviewed listing, adjustment, volume and session evidence")
    rows = provider("prices", code, start, target, source, deadline=deadline)
    prepare_input(db, code, source, rows)
    reference = evidence["reference_rows"]
    validated = validate_rows(reference)
    by_day = {row["date"]: row for row in rows}
    if (len(validated) < 2 or not all(start <= r[0] <= target and r[-1] for r in validated)
            or not all(by_day.get(r["date"]) == r for r in reference)):
        raise ValueError("Rebase reference bars do not match")
    with db:
        db.execute("BEGIN IMMEDIATE")
        save_rows(db, code, *symbol[:2], rows, start, target, full=True, source=source, strict=True, rebase=True)
        status, detail = coverage(db, code, source, start, target)
        if status not in PASS:
            raise ValueError(f"Rebase rejected: {detail}")
        version = hashlib.sha256(canonical([code, source, listed, evidence, rows]).encode()).hexdigest()
        basis = (code, source, version, listed, canonical(evidence), now_iso())
        db.execute("INSERT OR IGNORE INTO lab_basis_history(code,source,version,listed,evidence,approved_at) VALUES(?,?,?,?,?,?)", basis)
        db.execute("INSERT OR REPLACE INTO lab_symbol_basis VALUES(?,?,?,?,?,?)", basis)
        public_version(db)
    print(json.dumps({"code": code, "source": source, "basis": version, "from": start, "through": target, "rows": len(rows)}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--calendar-through", default=os.getenv("LAB_CALENDAR_THROUGH", "2026-12-31"))
    actions = parser.add_subparsers(dest="action", required=True)
    import_parser = actions.add_parser("import-candidates")
    import_parser.add_argument("folder", type=Path)
    import_parser.add_argument("--register", action="store_true")
    apply_parser = actions.add_parser("approve")
    apply_parser.add_argument("candidate")
    revoke_parser = actions.add_parser("withdraw")
    revoke_parser.add_argument("candidate")
    revoke_parser.add_argument("--reason", required=True)
    basis_parser = actions.add_parser("rebase")
    basis_parser.add_argument("code")
    basis_parser.add_argument("--source", choices=KIWOOM, required=True)
    basis_parser.add_argument("--listed", required=True)
    basis_parser.add_argument("--evidence", type=Path, required=True)
    nontrade = actions.add_parser("confirm-nontrade")
    nontrade.add_argument("code")
    nontrade.add_argument("day")
    nontrade.add_argument("--source", choices=("FDR:NAVER", "FDR:KRX", *KIWOOM), required=True)
    nontrade.add_argument("--evidence", required=True)
    listing = actions.add_parser("confirm-listing")
    listing.add_argument("code")
    listing.add_argument("listed")
    listing.add_argument("--evidence", required=True)
    args = parser.parse_args()
    target = completed_day(datetime.now(KST), "primary", args.calendar_through)
    with collection_lock(args.db), closing(connect(args.db)) as db:
        if args.action == "import-candidates":
            with db:
                checked_import(db, args.folder, target, args.register)
        elif args.action == "approve":
            return approve(db, args.candidate, target, time.monotonic() + 120)
        elif args.action == "rebase":
            rebase(db, args.code, args.source, args.listed, json.loads(args.evidence.read_text(encoding="utf-8-sig")), target, time.monotonic() + 180)
        elif args.action == "confirm-listing":
            if (not re.fullmatch(r"[0-9][0-9A-Z]{5}", args.code) or date.fromisoformat(args.listed).isoformat() != args.listed
                    or not args.evidence.strip() or db.execute("SELECT 1 FROM lab_symbol_basis WHERE code=?", (args.code,)).fetchone()):
                raise ValueError("Invalid listing evidence or symbol has a pinned basis")
            with db:
                db.execute("INSERT OR REPLACE INTO lab_listing_evidence VALUES(?,?,?)", (args.code, args.listed, args.evidence))
        elif args.action == "confirm-nontrade":
            from ai_agent.market import expected_sessions
            if (not re.fullmatch(r"[0-9][0-9A-Z]{5}", args.code) or date.fromisoformat(args.day).isoformat() != args.day
                    or args.day > target or not expected_sessions(args.day, args.day) or not args.evidence.strip()):
                raise ValueError("Invalid nontrade evidence or session")
            with db:
                db.execute("INSERT INTO lab_nontrade VALUES(?,?,?,?)", (args.code, args.day, args.source, args.evidence))
                public_version(db)
        else:
            row = db.execute("SELECT code,date FROM lab_recovery_candidates WHERE id=?", (args.candidate,)).fetchone()
            if not row or not any(r[0] == args.candidate for r in active_recoveries(db, row[0])):
                raise ValueError("Candidate is not applied")
            with db:
                withdraw(db, *row, args.candidate, args.reason)
                refresh_quality(db, row[0])
                public_version(db)
    return 0


if __name__ == "__main__":
    sys.exit(main())
