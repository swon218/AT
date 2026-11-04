"""Read-only cutover report for a frozen pre-change backup and a 03:00 rehearsal."""
import argparse
from collections import Counter
from contextlib import closing
from datetime import date
import json
from pathlib import Path
import sqlite3


PASS = {"complete", "nontrade"}


def open_snapshot(path):
    db = sqlite3.connect(path.resolve(strict=True).as_uri() + "?mode=ro", uri=True)
    db.execute("PRAGMA query_only=ON")
    db.execute("BEGIN")
    return db


def objects(db):
    return {name for name, in db.execute("SELECT name FROM sqlite_master WHERE type IN ('table','view')")}


def active(db):
    return dict(db.execute("SELECT code,error FROM symbols WHERE active=1"))


def candles(db, schema, code, start, target, strict):
    view = next((name for name in ("effective_candle_quality", "current_candle_quality") if name in schema), None)
    issues = {}
    if view:
        for day, status, source, raw_hash, policy, reason in db.execute(
                f"""SELECT date,status,source,raw_hash,policy,reason FROM {view}
                    WHERE code=? AND date BETWEEN ? AND ? AND status IN ('corrected','quarantined')""", (code, start, target)):
            issues[day] = dict(status="quarantined" if strict else status, decision=status,
                               source=source, raw_hash=raw_hash, policy=policy, reason=reason)
    hidden = {day for day, issue in issues.items() if issue["status"] == "quarantined"}
    usable = {day for day, in db.execute("SELECT date FROM candles WHERE code=? AND date BETWEEN ? AND ?",
                                        (code, start, target))} - hidden
    return usable, hidden, issues


def compare(before, after, target):
    d = date.fromisoformat(target)
    start = d.replace(year=d.year-5, day=min(d.day, 28) if d.month == 2 else d.day).isoformat()
    old_schema, new_schema = objects(before), objects(after)
    old_active, new_active = active(before), active(after)
    required = {"lab_publication", "lab_public_symbols", "lab_batches", "lab_batch_items",
                "effective_candle_quality", "lab_symbol_basis", "lab_listing_evidence"}
    if not required <= new_schema:
        raise ValueError("Rehearsal has not been migrated and published")
    published = after.execute("SELECT version,target,published_at,summary FROM lab_publication WHERE id=1").fetchone()
    if not published or published[1] != target:
        raise ValueError("Rehearsal publication does not match the requested target")
    old_strict = "lab_publication" in old_schema and before.execute(
        "SELECT 1 FROM lab_publication WHERE id=1 AND target IS NOT NULL").fetchone() is not None
    batch_times = {phase: (finished, at) for phase, finished, at in after.execute(
        "SELECT phase,finished_at,published_at FROM lab_batches WHERE day=?", (target,))}
    batches = {phase: dict(after.execute("SELECT code,status FROM lab_batch_items WHERE day=? AND phase=?", (target, phase)))
               for phase in ("primary", "confirm")}
    statuses = dict(after.execute("SELECT code,status FROM lab_public_symbols WHERE target=?", (target,)))
    listings = dict(after.execute("""SELECT i.code,coalesce(b.listed,e.listed,i.listed)
        FROM lab_batch_items i LEFT JOIN lab_symbol_basis b USING(code) LEFT JOIN lab_listing_evidence e USING(code)
        WHERE i.day=? AND i.phase='confirm'""", (target,)))
    summary = json.loads(published[3])
    errors = []
    if not batch_times.get("primary", (None,))[0] or batch_times.get("confirm") != (published[2], published[2]):
        errors.append("both_phases_must_finish_for_target")
    if not statuses or statuses != batches["confirm"] or set(statuses) != set(batches["primary"]) or set(statuses) != set(new_active):
        errors.append("primary_confirm_public_and_active_universes_must_match")
    counts = dict(Counter(statuses.values()))
    if counts != summary.get("counts") or dict(Counter(batches["primary"].values())) != summary.get("primary"):
        errors.append("publication_counts_do_not_match_batch")
    if summary.get("data_day") != target or not counts.get("complete"):
        errors.append("target_has_no_verified_public_candles")

    previous, current = Counter(), Counter()
    old_failures, new_failures = set(), set()
    legacy_corrected, newly_quarantined, lost_usable = [], [], []
    for code in sorted(old_active.keys() | new_active.keys()):
        old_usable, old_hidden, old_issues = candles(before, old_schema, code, start, target, old_strict) if code in old_active else (set(), set(), {})
        new_usable, new_hidden, new_issues = candles(after, new_schema, code, start, target, True) if code in new_active else (set(), set(), {})
        previous.update(usable_candles=len(old_usable), quarantined_candles=len(old_hidden))
        current.update(usable_candles=len(new_usable), quarantined_candles=len(new_hidden))
        if code in old_active and (old_active[code] or old_hidden):
            old_failures.add(code)
        if code in new_active and (statuses.get(code) not in PASS or new_hidden):
            new_failures.add(code)
        if statuses.get(code) == "complete" and target not in new_usable:
            errors.append(f"complete_without_usable_target:{code}")
        if code not in new_active:
            continue  # Removed listings are reported separately.
        first, last = after.execute("SELECT min(date),max(date) FROM candles WHERE code=?", (code,)).fetchone()
        valid_start = max(start, listings.get(code) or start)
        if first and (first < valid_start or last > target):
            errors.append(f"candle_outside_retention_or_listing:{code}")
        for day, issue in sorted(old_issues.items()):
            if issue["decision"] == "corrected":
                legacy_corrected.append(dict(code=code, date=day, **issue, usable_after=day in new_usable))
        for day in sorted(new_hidden - old_hidden):
            newly_quarantined.append(dict(code=code, date=day, **new_issues[day]))
        if old_usable - new_usable:
            lost_usable.append(dict(code=code, dates=sorted(old_usable - new_usable)))

    # A new bar elsewhere cannot offset a lost previously usable bar.
    new_failed = sorted(new_failures - old_failures)
    if newly_quarantined:
        errors.append("new_quarantine_requires_source_review")
    if lost_usable:
        errors.append("previously_usable_candles_lost")
    if new_failed:
        errors.append("additional_failed_symbols")
    previous.update(active_symbols=len(old_active), failed_symbols=len(old_failures))
    current.update(active_symbols=len(new_active), failed_symbols=len(new_failures))
    old_run = before.execute("SELECT succeeded,failed FROM runs ORDER BY id DESC LIMIT 1").fetchone()
    return dict(passed=not errors, errors=errors, window={"start": start, "end": target},
                before=dict(previous), after=dict(current), delta={k: current[k]-previous[k] for k in previous},
                legacy_last_run=dict(zip(("succeeded", "failed"), old_run)) if old_run else None,
                publication_version=published[0], published_at=published[2], confirm_counts=counts,
                added_symbols=sorted(new_active.keys()-old_active.keys()), removed_symbols=sorted(old_active.keys()-new_active.keys()),
                failed_before=sorted(old_failures), failed_after=sorted(new_failures), newly_failed=new_failed,
                legacy_corrected=legacy_corrected, newly_quarantined=newly_quarantined, lost_usable=lost_usable)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--before", required=True, type=Path)
    parser.add_argument("--after", required=True, type=Path)
    parser.add_argument("--target", required=True, type=lambda value: date.fromisoformat(value).isoformat())
    args = parser.parse_args()
    try:
        if args.before.samefile(args.after):
            raise ValueError("Use separate baseline and rehearsal databases")
        with closing(open_snapshot(args.before)) as before, closing(open_snapshot(args.after)) as after:
            if any(db.execute("PRAGMA quick_check").fetchall() != [("ok",)] for db in (before, after)):
                raise ValueError("SQLite quick_check failed")
            if after.execute("PRAGMA foreign_key_check").fetchone():
                raise ValueError("Rehearsal foreign_key_check failed")
            report = compare(before, after, args.target)
    except (OSError, ValueError, sqlite3.Error) as error:
        report = {"passed": False, "errors": [str(error)]}
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
