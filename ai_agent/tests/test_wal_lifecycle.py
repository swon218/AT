"""Commit identity regressions, independent of OS metadata/sidecar lifetime."""
import os
import sqlite3
import stat
from ai_agent.config import Settings
from ai_agent.screener import RsiScreener
from ai_agent.snapshot_fingerprint import fingerprint
from .fixtures import make_lab


def test_acl_and_wal_timestamp_changes_are_not_data_commits(tmp_path):
    path = tmp_path / 'metadata.sqlite'; make_lab(path)
    writer = sqlite3.connect(path)
    scanner = RsiScreener()
    try:
        writer.execute("UPDATE symbols SET name='Baseline' WHERE code='005930'"); writer.commit()
        settings = Settings(lab_path=str(path))
        first = scanner.scan(settings, 'ALL', '2026-10-27')
        initial = fingerprint(path)
        # chmod/ACL changes only main-file ctime. Read marks/ACL operations may
        # also change sidecar metadata; neither changes its verified commit.
        os.chmod(path, stat.S_IMODE(path.stat().st_mode))
        wal = path.with_name(path.name + '-wal')
        os.chmod(wal, stat.S_IMODE(wal.stat().st_mode))
        os.utime(wal, None)
        assert fingerprint(path) == initial
        assert scanner.scan(settings, 'ALL', '2026-10-27')['cache_hit']
        writer.execute("UPDATE symbols SET name='Actual commit' WHERE code='005930'"); writer.commit()
        changed = scanner.scan(settings, 'ALL', '2026-10-27')
        assert changed['data_version'] != first['data_version'] and not changed['cache_hit']
    finally:
        scanner.close(); writer.close()


def test_fully_checkpointed_wal_retention_or_removal_is_same_snapshot(tmp_path):
    path = tmp_path / 'checkpoint.sqlite'; make_lab(path)
    writer = sqlite3.connect(path)
    try:
        writer.execute("UPDATE symbols SET name='Checkpointed' WHERE code='005930'"); writer.commit()
        assert writer.execute('PRAGMA wal_checkpoint(FULL)').fetchone()[0] == 0
        initial = fingerprint(path)
        assert path.with_name(path.name + '-wal').stat().st_size > 32
    finally:
        writer.close()
    assert not path.with_name(path.name + '-wal').exists()
    assert fingerprint(path) == initial
    scanner = RsiScreener()
    try:
        assert scanner.scan(Settings(lab_path=str(path)), 'ALL', '2026-10-27')['valid'] == 3
        assert scanner.scan(Settings(lab_path=str(path)), 'ALL', '2026-10-27')['cache_hit']
        assert fingerprint(path) == initial
    finally:
        scanner.close()


def test_wal_allocation_without_commit_does_not_invalidate_a_snapshot(tmp_path):
    path = tmp_path / 'uncommitted.sqlite'; make_lab(path)
    writer = sqlite3.connect(path)
    try:
        writer.execute('PRAGMA wal_autocheckpoint=0')
        writer.execute('CREATE TABLE padding(value BLOB)'); writer.commit()
        initial = fingerprint(path)
        wal = path.with_name(path.name + '-wal')
        before = wal.stat().st_size
        writer.execute('PRAGMA cache_size=1')
        writer.execute('BEGIN IMMEDIATE')
        writer.execute('INSERT INTO padding VALUES(zeroblob(262144))')
        assert wal.stat().st_size > before
        assert fingerprint(path) == initial
        writer.commit()
        assert fingerprint(path) != initial
    finally:
        writer.close()
