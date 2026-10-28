"""Public fixture-only diagnosis; does not accept an operational DB path."""
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from .fixtures import make_lab
from ai_agent.screener import RsiScreener


def describe(path, stage):
    # Raw DB descriptors must never be opened/closed in a SQLite parent's
    # process on POSIX. This separate diagnostic child never imports sqlite3.
    code = "import sys,json;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from ai_agent.snapshot_fingerprint import _sample;print(json.dumps(_sample(Path(sys.argv[2]))))"
    parts = json.loads(subprocess.check_output([sys.executable, '-I', '-S', '-c', code, str(Path(__file__).parents[2]), str(path)]))
    print(json.dumps(dict(stage=stage, db_stat=parts[0], header_hash=hashlib.sha256(parts[1].encode()).hexdigest(),
                          wal=parts[2]), ensure_ascii=False), flush=True)


def main():
    with tempfile.TemporaryDirectory(prefix='atlas-lifecycle-fixture-') as root:
        path = Path(root) / 'fixture.sqlite'; make_lab(path)
        with sqlite3.connect(path) as writer:
            writer.execute("UPDATE candles SET high=1 WHERE code='005930' AND date='2026-10-27'")
        describe(path, 'writer_commit')
        scanner = RsiScreener()
        reader = scanner._connect(path)
        try:
            describe(path, 'reader_open')
            reader.execute('BEGIN'); reader.execute('SELECT rootpage FROM sqlite_master LIMIT 1').fetchone()
            describe(path, 'reader_pinned')
            reader.rollback(); describe(path, 'reader_rollback')
            reader.close(); describe(path, 'reader_closed')
        finally:
            reader.close(); writer.close(); scanner.close()


if __name__ == '__main__':
    main()
