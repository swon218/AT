import contextlib
import io
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from collect import collect, collection_lock
from store import connect, query, save_rows


class CollectorQualityTests(unittest.TestCase):
    def test_targeted_retry_saves_usable_rows_reports_partial_failure_and_is_repeatable(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'lab.sqlite'
            row = dict(date='2025-01-02', open=100, high=110, low=90, close=105, volume=20)
            db = connect(path)
            save_rows(db, '005930', 'Existing', 'KOSPI', [row], '2025-01-01', '2025-01-31')
            with db:
                for code in ('000001', '000002'):
                    db.execute("INSERT INTO symbols(code,name,market,source,error) VALUES(?,?,?,'FDR:NAVER','Invalid OHLC range')", (code, code, 'KOSDAQ'))
            original = db.execute("SELECT * FROM candles WHERE code='005930'").fetchall()
            db.close()
            args = SimpleNamespace(db=str(path), retry_invalid_ohlc=True, symbols=None, full=True, max_minutes=10, delay=0, end='2025-01-31', source='NAVER')
            def provider(kind, code, *unused):
                self.assertEqual(kind, 'prices')
                self.assertIn(code, ('000001', '000002'))
                return [row, {**row, 'date': '2025-01-03', 'close': 111 if code == '000001' else 160}]
            with patch('collect.fetch', side_effect=provider) as fetch, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(collect(args), 1)
                self.assertEqual(fetch.call_count, 2)
                self.assertEqual(collect(args), 1)
                self.assertEqual(fetch.call_count, 3)  # only the unresolved symbol is retried
            db = connect(path)
            self.assertEqual(db.execute("SELECT * FROM candles WHERE code='005930'").fetchall(), original)
            self.assertEqual(db.execute('SELECT succeeded,failed,message FROM runs ORDER BY id').fetchall(), [(1, 1, None), (0, 1, None)])
            self.assertEqual(db.execute("SELECT count(*) FROM raw_candles WHERE code IN ('000001','000002')").fetchone()[0], 4)
            self.assertEqual(query(path, '000001')['quality']['corrected'], 1)
            self.assertEqual(query(path, '000002')['items'][1]['quality'], 'quarantined')
            self.assertEqual(len(query(path, '000002')['items']), 2)
            db.close()

    def test_storage_lock_rejects_duplicate_collection(self):
        with tempfile.TemporaryDirectory() as tmp:
            with collection_lock(Path(tmp) / 'test.sqlite'):
                with self.assertRaises(OSError):
                    with collection_lock(Path(tmp) / 'test.sqlite'):
                        self.fail('duplicate collector acquired lock')


if __name__ == '__main__':
    unittest.main()
