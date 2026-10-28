"""Keep SQLite-owned WAL sidecars available to a separately read-only reader.

Run as the existing DB owner, never as atlas-ai or root on an owner else's DB.
No rows, schema, journal mode, timers or broker environment are changed. The
owner connection initializes WAL infrastructure, holds no read transaction,
and grants only r-- ACLs on the two exact SQLite sidecar files.
"""
import argparse
import os
from pathlib import Path
import shutil
import signal
import socket
import sqlite3
import stat
import subprocess
import threading


class GuardUnavailable(Exception):
    pass


def identity(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid():
        raise GuardUnavailable('wal_guard_owner_or_file_mismatch')
    return info.st_dev, info.st_ino


class WalGuard:
    def __init__(self, path, reader):
        if os.name != 'posix': raise GuardUnavailable('wal_guard_requires_posix')
        import pwd
        self.path = Path(path).absolute()
        self.reader_uid = pwd.getpwnam(reader).pw_uid
        if self.reader_uid == os.geteuid(): raise GuardUnavailable('wal_guard_reader_must_be_separate')
        if not shutil.which('setfacl'): raise GuardUnavailable('wal_guard_setfacl_required')
        self.db, self.files = None, {}

    def open(self):
        self.files[self.path] = identity(self.path)
        try:
            # READWRITE opens an existing DB only: the established collector's
            # owner can initialize SQLite sidecars. Query-only prevents any SQL
            # DML/DDL. The research process still opens mode=ro, unchanged.
            self.db = sqlite3.connect(self.path.as_uri() + '?mode=rw', uri=True, timeout=2)
            self.db.execute('PRAGMA query_only=ON')
            if self.db.execute('PRAGMA journal_mode').fetchone()[0] != 'wal':
                raise GuardUnavailable('wal_guard_existing_wal_required')
            self.db.set_authorizer(lambda op, *args: sqlite3.SQLITE_OK if op in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ) else sqlite3.SQLITE_DENY)
            self.db.execute('SELECT rootpage FROM sqlite_master LIMIT 1').fetchall()
            if self.db.in_transaction: raise GuardUnavailable('wal_guard_snapshot_retained')
            for suffix in ('-wal', '-shm'):
                path = Path(str(self.path) + suffix)
                before = identity(path)
                # Never recalculate a pre-existing ACL mask: that could unmask
                # write bits on unrelated group/user entries. SQLite inherits
                # sidecar modes from the readable source DB; otherwise fail for
                # an explicit owner-side ACL review, rather than broaden access.
                if not path.stat().st_mode & stat.S_IRGRP:
                    raise GuardUnavailable('wal_guard_acl_mask_requires_review')
                subprocess.run(['setfacl', '--no-mask', '-m', f'u:{self.reader_uid}:r--', '--', str(path)],
                               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)
                if identity(path) != before: raise GuardUnavailable('wal_guard_sidecar_changed')
                self.files[path] = before
            self.check()
        except BaseException:
            self.close()
            raise
        return self

    def check(self):
        if not self.db or self.db.in_transaction: raise GuardUnavailable('wal_guard_snapshot_retained')
        if any(identity(path) != stamp for path, stamp in self.files.items()):
            raise GuardUnavailable('wal_guard_file_replaced')

    def close(self):
        if self.db is not None:
            self.db.close(); self.db = None


def notify_ready():
    target = os.getenv('NOTIFY_SOCKET')
    if target:
        target = '\0' + target[1:] if target.startswith('@') else target
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sock:
            sock.connect(target); sock.sendall(b'READY=1')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--db', required=True)
    parser.add_argument('--reader', default='atlas-ai')
    args = parser.parse_args()
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT): signal.signal(sig, lambda *_: stop.set())
    guard = WalGuard(args.db, args.reader)
    try:
        guard.open()
        notify_ready()
        print('WAL_READONLY_READY', flush=True)
        while not stop.wait(2): guard.check()
    except Exception as error:
        # No raw SQL/path/user details or environment values in service output.
        print(str(error) if isinstance(error, GuardUnavailable) else 'wal_guard_unavailable', flush=True)
        return 1
    finally:
        guard.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
