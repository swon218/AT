from contextlib import closing, redirect_stdout
from datetime import datetime
from io import StringIO
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import nightly
import recovery
from ai_agent.screener import RsiScreener
from store import KST, SOURCE, active_recoveries, connect, prepare_rows, query, save_rows


def bar(day, close=105):
    return dict(date=day, open=100, high=110, low=90, close=close, volume=20)


class NightlyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "lab.sqlite"
        self.db = connect(self.path)
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.db.close)
        self.day = "2026-10-30"
        self.listed = "2026-10-29"

    def listing(self, *codes):
        return [dict(code=code, name=code, market="KOSPI" if i == 0 else "KOSDAQ", listed=self.listed)
                for i, code in enumerate(codes)]

    def run_phase(self, phase, *, short=False, seconds=20):
        with redirect_stdout(StringIO()):
            return nightly.run(self.db, phase, self.day, time.monotonic() + seconds, 0, short)

    def test_two_phases_keep_stage_invisible_publish_partial_then_retry(self):
        listing = self.listing("005930", "000660", "00680K", "000001")
        with self.db:
            self.db.execute("INSERT INTO lab_nontrade VALUES('000001',?,?,'fixture')", (self.day, SOURCE))
        before, latest = bar(self.listed), bar(self.day)
        phase = "primary"
        price_calls = []

        def provider(kind, code=None, begin=None, day=None, source=None, **unused):
            if kind == "listing":
                return listing
            price_calls.append((phase, code, begin))
            if code == "000001":
                return [before]
            if code == "000660" and phase == "primary":
                return [before]
            if code == "00680K" and phase != "retry":
                return [before, bar(self.day, 111)]
            return [before, latest]

        save_rows(self.db, "00680K", "Old", "KOSDAQ", [before], self.listed, self.listed)
        with patch("nightly.provider", side_effect=provider):
            self.assertEqual(self.run_phase("primary"), 2)
            self.assertEqual(query(self.path, "005930")["items"], [])
            self.assertEqual(query(self.path)["publication"]["primary"]["counts"],
                             {"complete": 1, "nontrade": 1, "not_reflected": 1, "quality_failed": 1})
            phase = "confirm"
            original = nightly.apply_update

            def observe(*args):
                original(*args)
                self.assertEqual(query(self.path, "005930")["items"], [])

            with patch("nightly.apply_update", side_effect=observe):
                self.assertEqual(self.run_phase("confirm"), 2)
            self.assertEqual([c for p, c, _ in price_calls if p == "confirm"], ["000660", "00680K"])
            self.assertEqual(query(self.path, "005930")["items"][-1]["time"], self.day)
            residual = query(self.path, "00680K")
            self.assertEqual(residual["items"][-1]["time"], self.listed)
            self.assertEqual(residual["collection"]["status"], "quality_failed")
            phase = "retry"
            self.assertEqual(self.run_phase("confirm"), 0)
            self.assertEqual([c for p, c, _ in price_calls if p == "retry"], ["00680K"])
            public = query(self.path)["publication"]
            self.assertEqual(public["summary"]["counts"], {"complete": 3, "nontrade": 1})
            self.assertEqual(public["version"], 3)
            self.assertEqual(self.run_phase("confirm"), 0)
            self.assertEqual(query(self.path)["publication"]["version"], 3)

    def test_listing_failure_and_all_failed_do_not_claim_data(self):
        save_rows(self.db, "005930", "Old", "KOSPI", [bar(self.listed)], self.listed, self.listed)
        with patch("nightly.provider", return_value=[]):
            with self.assertRaises(nightly.ProviderError):
                self.run_phase("primary")
        self.assertEqual(query(self.path)["items"][0]["code"], "005930")

        def unavailable(kind, *args, **kwargs):
            if kind == "listing":
                return self.listing("005930", "000660")
            raise nightly.ProviderError("fixture")

        with patch("nightly.provider", side_effect=unavailable):
            self.assertEqual(self.run_phase("confirm"), 1)
        meta = query(self.path)["publication"]
        self.assertEqual(meta["summary"]["data_day"], self.listed)
        self.assertEqual(meta["summary"]["counts"], {"fetch_failed": 2})

    def test_interrupted_confirmation_resumes_without_refetching_completed(self):
        calls = []

        def provider(kind, code=None, *args, **kwargs):
            if kind == "listing":
                return self.listing("005930", "000660")
            calls.append(code)
            if code == "005930" and calls.count(code) == 1:
                raise KeyboardInterrupt()
            return [bar(self.listed), bar(self.day)]

        with patch("nightly.provider", side_effect=provider):
            with self.assertRaises(KeyboardInterrupt):
                self.run_phase("confirm")
            self.assertEqual(query(self.path, "000660")["items"], [])
            self.assertEqual(self.run_phase("confirm"), 0)
        self.assertEqual(calls, ["000660", "005930", "005930"])
        self.assertEqual(query(self.path, "000660")["items"][-1]["time"], self.day)

    def test_short_confirmation_uses_revised_latest_bar_without_full_fetch(self):
        calls = []
        confirming = False

        def provider(kind, code=None, begin=None, day=None, *args, **kwargs):
            if kind == "listing":
                return self.listing("005930", "000660")
            calls.append((confirming, code, begin))
            return [bar(self.listed), bar(self.day, 108 if confirming else 105)]

        with patch("nightly.provider", side_effect=provider):
            self.assertEqual(self.run_phase("primary"), 0)
            confirming = True
            self.assertEqual(self.run_phase("confirm", short=True), 0)
        self.assertEqual(len(calls), 4)
        self.assertTrue(all(begin == self.listed for _, _, begin in calls))
        self.assertEqual(query(self.path, "005930")["items"][-1]["close"], 108)

    def test_overlap_revision_forces_full_history_before_acceptance(self):
        start = "2026-07-01"
        dates = nightly.expected_sessions(start, self.day)
        before = [bar(d) for d in dates[:-1]]
        save_rows(self.db, "005930", "Fixture", "KOSPI", before, start, dates[-2], strict=True)
        calls = []

        def provider(kind, code, begin, end, source, **kwargs):
            calls.append(begin)
            return [bar(d, 103) for d in dates if begin <= d <= end]

        with patch("nightly.provider", side_effect=provider):
            change = nightly.fetch_update(self.db, "005930", SOURCE, start, self.day, time.monotonic() + 20)
        self.assertEqual(calls, ["2026-08-31", start])
        self.assertTrue(change["full"])
        self.assertEqual(query(self.path, "005930")["items"][-1]["close"], 105)

    def test_cutover_gate_blocks_legacy_correction_until_real_source_bar_is_valid(self):
        listing = self.listing("005930", "000660")
        for stock in listing:
            saved = bar(self.listed, 111 if stock["code"] == "005930" else 105)
            save_rows(self.db, stock["code"], stock["name"], stock["market"], [saved], self.listed, self.day)
        baseline = self.path.with_name("baseline.sqlite")
        with closing(connect(baseline)) as backup:
            self.db.backup(backup)
        validated = False

        def provider(kind, code=None, *args, **kwargs):
            if kind == "listing":
                return listing
            close = 111 if code == "005930" and not validated else 105
            return [bar(self.listed, close), bar(self.day)]

        def report():
            gate = subprocess.run(
                [sys.executable, "-m", "deploy.lab_transition_gate", "--before", str(baseline),
                 "--after", str(self.path), "--target", self.day],
                capture_output=True, text=True, timeout=20,
            )
            self.assertEqual(gate.stderr, "")
            result = json.loads(gate.stdout)
            self.assertEqual(gate.returncode, 0 if result["passed"] else 1)
            return result

        with patch("nightly.provider", side_effect=provider):
            self.assertEqual(self.run_phase("primary"), 2)
            self.assertEqual(self.run_phase("confirm"), 2)
            blocked = report()
            self.assertFalse(blocked["passed"])
            self.assertEqual(blocked["before"]["usable_candles"], 2)
            self.assertEqual(blocked["after"]["usable_candles"], 2)  # Another new bar masks the loss in totals.
            self.assertEqual(blocked["delta"]["quarantined_candles"], 1)
            self.assertEqual(blocked["newly_failed"], ["005930"])
            self.assertEqual(blocked["newly_quarantined"][0]["decision"], "corrected")
            self.assertEqual(blocked["lost_usable"], [dict(code="005930", dates=[self.listed])])
            validated = True
            self.assertEqual(self.run_phase("confirm"), 0)
        allowed = report()
        self.assertTrue(allowed["passed"], allowed["errors"])
        self.assertTrue(allowed["legacy_corrected"][0]["usable_after"])
        self.assertEqual(allowed["after"]["usable_candles"], 4)

    def test_deadline_keeps_unprocessed_items_and_calendar_handles_holidays(self):
        with patch("nightly.provider", return_value=self.listing("005930", "000660")) as fetch:
            self.assertEqual(self.run_phase("primary", seconds=-1), 1)
            self.assertEqual(fetch.call_count, 1)
            self.assertEqual(nightly.counts(self.db, self.day, "primary"), {"pending": 2})
        for phase, now, expected in [
            ("primary", datetime(2026, 7, 17, 21, tzinfo=KST), "2026-07-16"),
            ("confirm", datetime(2026, 7, 18, 3, tzinfo=KST), "2026-07-16"),
            ("confirm", datetime(2027, 1, 1, 3, tzinfo=KST), "2026-12-30"),
            ("confirm", datetime(2026, 11, 2, 19, tzinfo=KST), "2026-10-30"),
        ]:
            self.assertEqual(nightly.completed_day(now, phase, "2027-12-31"), expected)
        self.assertEqual(nightly.scope(self.db, "005930", "2012-01-01", self.day)[1], "2021-10-30")
        self.assertEqual(nightly.scope(self.db, "005930", "2023-10-30", self.day)[1], "2023-10-30")

    def test_recovery_basis_changes_and_public_analysis_use_same_price(self):
        sessions = nightly.expected_sessions("2026-10-01", self.day)
        broken = sessions[6]
        reference = [bar(d) for d in sessions]
        raw = [bar(d, 116 if d == broken else 105) for d in sessions]
        code = "005930"
        save_rows(self.db, code, "Old", "KOSPI", raw, sessions[0], self.day, strict=True)
        actual = prepare_rows([bar(broken, 116)])[0]
        with self.db:
            self.db.execute("INSERT INTO lab_recovery_candidates VALUES(?,?,?,?,?,?,?,?,?,?)",
                            ("candidate", code, broken, SOURCE, actual["hash"], actual["policy"],
                             nightly.KIWOOM[0], "fixture-basis", json.dumps(bar(broken)), "{}"))
        with patch("recovery.provider", return_value=reference), redirect_stdout(StringIO()):
            self.assertEqual(recovery.approve(self.db, "candidate", self.day, time.monotonic() + 20), 0)
        for full in (False, True):
            save_rows(self.db, code, "Old", "KOSPI", raw, sessions[0], self.day, full, strict=True)
            data = query(self.path, code)
            self.assertEqual(data["quality"]["recovered"], 1)
            self.assertEqual(data["quality"]["issues"][0]["recovery"]["candidate"], "candidate")
            self.assertEqual(data["items"][6]["close"], 105)
        with self.db:
            nightly.public_version(self.db, self.day, {"data_day": self.day})
        scanner = RsiScreener()
        self.addCleanup(scanner.close)
        settings = SimpleNamespace(lab_path=str(self.path), screen_symbols=10, tool_seconds=10)
        scan = scanner.scan(settings, "ALL", "2026-11-02")
        self.assertEqual((scan["cutoff"], scan["valid"], scan["items"][0]["rsi"]), (self.day, 1, 50))
        with self.db:
            self.db.execute("INSERT INTO lab_attempts(day,phase,code,at,status) VALUES(?,'primary',?,?,'complete')", (self.day, code, self.day))
        self.assertTrue(scanner.scan(settings, "ALL", "2026-11-02")["cache_hit"])
        save_rows(self.db, code, "Old", "KOSPI", [bar(broken, 119)], broken, self.day, strict=True)
        with self.db:
            nightly.public_version(self.db)
        self.assertFalse(active_recoveries(self.db, code))
        self.assertEqual(query(self.path, code)["quality"]["quarantined"], 1)
        self.assertEqual(scanner.scan(settings, "ALL", self.day)["valid"], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM raw_candles WHERE date=?", (broken,)).fetchone()[0], 2)

    def test_rebase_checks_full_coverage_and_keeps_source_for_next_run(self):
        code = "005930"
        source = nightly.KIWOOM[1]
        rows = [bar(self.listed), bar(self.day)]
        save_rows(self.db, code, "Old", "KOSPI", rows, self.listed, self.day)
        evidence = dict(source=source, listed=self.listed, reference_rows=rows, reviewer="fixture",
                        listing_reference="fixture", adjustment_reference="fixture",
                        volume_reference="fixture", session_reference="fixture")
        with patch("recovery.provider", return_value=rows), redirect_stdout(StringIO()):
            recovery.rebase(self.db, code, source, self.listed, evidence, self.day, time.monotonic() + 20)
        with self.assertRaisesRegex(ValueError, "approved basis"):
            save_rows(self.db, code, "Old", "KOSPI", rows, self.listed, self.day, full=True)
        with patch("nightly.provider", return_value=rows) as fetch:
            pinned, start, _ = nightly.scope(self.db, code, None, self.day)
            nightly.fetch_update(self.db, code, pinned, start, self.day, time.monotonic() + 20)
            self.assertEqual(fetch.call_args.args[-1], source)
        self.assertEqual(query(self.path, code)["basis"]["source"], source)


if __name__ == "__main__":
    unittest.main()
