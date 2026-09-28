import tempfile
from pathlib import Path
import unittest
import json
import sqlite3
from store import connect, query, save_rows, validate_rows, prepare_rows


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "test.sqlite"
        self.db = connect(self.path)
        self.rows = [{"date": "2025-01-02", "open": 100, "high": 110, "low": 90, "close": 105, "volume": 20}]

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def save(self, rows=None, **kwargs):
        return save_rows(self.db, "005930", "Samsung", "KOSPI", rows or self.rows, "2025-01-01", "2025-01-31", **kwargs)

    def test_idempotent_upsert_and_correction(self):
        self.save(); self.save()
        self.save([{**self.rows[0], "close": 107}])
        data = query(self.path, "005930")
        self.assertEqual(len(data["items"]), 1)
        self.assertEqual(data["items"][0]["close"], 107)
        self.assertEqual(query(self.path)["items"][0]["bars"], 1)

    def test_invalid_full_response_preserves_existing_data(self):
        self.save()
        self.save([{**self.rows[0], "high": 80}], full=True)
        self.assertEqual(self.db.execute('SELECT close FROM candles').fetchone()[0], 105)
        self.assertEqual(query(self.path, "005930")["items"][0]["quality"], "quarantined")
        self.assertIsNone(query(self.path, "005930")["items"][0]["close"])
        self.assertEqual(query(self.path)["items"][0]["bars"], 0)

    def test_exact_one_krw_high_and_low_corrections_preserve_raw_and_audit(self):
        rows = [{**self.rows[0], "close": 111}, {**self.rows[0], "date": "2025-01-03", "close": 89}]
        self.save(rows); self.save(rows)
        data = query(self.path, "005930")
        self.assertEqual(data["quality"]["corrected"], 2)
        self.assertEqual(data["items"][0]["high"], 111)
        self.assertEqual(data["items"][1]["low"], 89)
        self.assertEqual([i["raw"] for i in data["quality"]["issues"]], rows)
        for raw, item in zip(rows, data["items"]):
            for field in ("open", "close", "volume"):
                self.assertEqual(raw[field], item[field])
        self.assertEqual(self.db.execute('SELECT count(*) FROM raw_candles').fetchone()[0], 2)
        self.assertEqual(self.db.execute('SELECT count(*) FROM candle_quality_versions').fetchone()[0], 2)
        with self.assertRaisesRegex(ValueError, 'Invalid OHLC range'):
            validate_rows(rows)  # strict validator is unchanged

    def test_ineligible_errors_are_quarantined_without_rounding(self):
        for changes in ({"close": 112}, {"close": 110.5}, {"close": 111.0001}, {"open": 111}, {"high": 89}, {"close": 111, "open": 111}):
            with self.subTest(changes=changes):
                p = prepare_rows([{**self.rows[0], **changes}])[0]
                self.assertEqual(p["status"], "quarantined")
        self.assertEqual(prepare_rows([{**self.rows[0], "close": 111}], "FDR:KRX")[0]["status"], "quarantined")

    def test_zero_volume_does_not_bypass_range_policy(self):
        self.assertEqual(prepare_rows([{**self.rows[0], "volume": 0, "close": 112}])[0]["status"], "quarantined")
        self.assertEqual(prepare_rows([{**self.rows[0], "high": 0}])[0]["status"], "quarantined")
        self.assertEqual(prepare_rows([{**self.rows[0], "open": 0, "high": 0, "low": 0, "volume": 0}])[0]["status"], "original")

    def test_mixed_batch_preserves_normal_bars_and_explicit_missing_dates(self):
        rows = [self.rows[0], {**self.rows[0], "date": "2025-01-03", "close": 111},
                {**self.rows[0], "date": "2025-01-04", "close": 160}]
        self.assertEqual(self.save(rows), 2)
        data = query(self.path, "005930")
        self.assertEqual(len(data["items"]), 3)
        self.assertEqual(data["quality"]["quarantined"], 1)
        self.assertEqual(data["quality"]["issues"][-1]["delta"], 50)
        self.assertEqual(query(self.path)["items"][0]["bars"], 2)
        self.assertEqual(self.db.execute('SELECT count(*) FROM raw_candles').fetchone()[0], 3)

    def test_provider_resolution_keeps_prior_raw_versions_and_decisions(self):
        self.save([{**self.rows[0], "close": 112}])
        self.save([{**self.rows[0], "close": 111}])
        self.save()
        data = query(self.path, "005930")
        self.assertEqual(data["quality"]["issues"], [])
        self.assertEqual(data["items"][0]["quality"], "original")
        self.assertEqual(self.db.execute('SELECT count(*) FROM raw_candles').fetchone()[0], 3)
        self.assertEqual(self.db.execute('SELECT count(*) FROM candle_quality_versions').fetchone()[0], 3)
        self.assertIsNone(data["symbol"]["error"])

    def test_omitted_date_cannot_silently_resolve_quarantine(self):
        self.save([self.rows[0], {**self.rows[0], 'date': '2025-01-03', 'close': 112}])
        with self.assertRaisesRegex(ValueError, 'missing known dates'):
            self.save(full=True)
        self.assertEqual(query(self.path, '005930')['quality']['quarantined'], 1)

    def test_legacy_migration_is_additive_and_old_values_are_snapshotted(self):
        self.save()
        self.db.executescript('DROP VIEW current_candle_quality; DROP TABLE candle_quality; DROP TABLE candle_quality_versions; DROP TABLE raw_candles; DROP TABLE legacy_candle_snapshots;')
        before = self.db.execute('SELECT * FROM candles').fetchall()
        self.assertIsNone(query(self.path, "005930")["quality"]["policy"])
        self.db.close(); self.db = connect(self.path)
        self.assertEqual(self.db.execute('SELECT * FROM candles').fetchall(), before)
        self.save([{**self.rows[0], "close": 111}])
        self.assertEqual(self.db.execute('SELECT close FROM legacy_candle_snapshots').fetchone()[0], 105)
        self.assertEqual(json.loads(self.db.execute('SELECT payload FROM raw_candles').fetchone()[0])["close"], 111)

    def test_transaction_rollback_and_retention_keep_audit(self):
        self.save()
        self.db.execute("CREATE TRIGGER fail_update BEFORE INSERT ON candles BEGIN SELECT RAISE(ABORT,'test rollback'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.save([{**self.rows[0], "close": 111}])
        self.assertEqual(self.db.execute('SELECT count(*) FROM raw_candles').fetchone()[0], 1)
        self.assertEqual(query(self.path, '005930')["quality"]["corrected"], 0)
        self.db.execute('DROP TRIGGER fail_update')
        save_rows(self.db, '005930', 'Samsung', 'KOSPI', [{**self.rows[0], 'date': '2025-02-01'}], '2025-02-01', '2025-02-28', full=True)
        self.assertEqual(len(query(self.path, '005930')["items"]), 1)
        self.assertEqual(self.db.execute('SELECT count(*) FROM raw_candles').fetchone()[0], 2)

    def test_source_switch_requires_full_refresh(self):
        self.save()
        with self.assertRaises(ValueError):
            self.save(source="FDR:KRX")
        self.save(source="FDR:KRX", full=True)
        self.assertEqual(query(self.path, "005930")["symbol"]["source"], "FDR:KRX")

    def test_suspension_and_missing_database(self):
        clean = validate_rows([{**self.rows[0], "open": 0, "high": 0, "low": 0, "volume": 0}])
        self.assertEqual(clean[0][-1], 0)
        self.assertFalse(query(Path(self.temp.name) / "missing.sqlite")["ready"])

    def test_duplicate_nonfinite_and_future_rows_rejected(self):
        for rows in ([*self.rows, *self.rows], [{**self.rows[0], "close": float("nan")}], [{**self.rows[0], "date": "2026-01-02"}]):
            with self.assertRaises(ValueError):
                self.save(rows)

    def test_truncated_history_does_not_replace_full_database(self):
        rows = [{**self.rows[0], "date": f"2025-01-{day:02d}"} for day in range(1, 26)]
        self.save(rows, full=True)
        with self.assertRaises(ValueError):
            self.save(full=True)
        self.assertEqual(len(query(self.path, "005930")["items"]), 25)

    def test_alphanumeric_krx_codes_are_supported(self):
        save_rows(self.db, "00680K", "Preferred", "KOSPI", self.rows, "2025-01-01", "2025-01-31")
        self.assertEqual(query(self.path, "00680K")["symbol"]["code"], "00680K")


if __name__ == '__main__':
    unittest.main()
