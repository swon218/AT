import tempfile
from pathlib import Path
import unittest
from store import connect, query, save_rows, validate_rows


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
        with self.assertRaises(ValueError):
            self.save([{**self.rows[0], "high": 80}], full=True)
        self.assertEqual(query(self.path, "005930")["items"][0]["close"], 105)

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
