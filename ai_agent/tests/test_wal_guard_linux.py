"""Real distinct-UID Linux integration, run by CI sudo on disposable fixtures.

The writer/guard is unprivileged, and the reader has no writable DB/directory.
This is not an injected permission error or a privileged replacement reader.
"""
import os
from pathlib import Path
import select
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import pytest
from .fixtures import make_lab

pytestmark = pytest.mark.skipif(os.name != 'posix' or os.geteuid() != 0, reason='Requires isolated Linux root test runner for real UID separation')


def demote(uid, gid):
    def apply():
        os.setgroups([]); os.setgid(gid); os.setuid(uid)
    return apply


def test_real_owner_guard_makes_no_wal_database_readable_without_reader_write_access():
    import pwd
    assert shutil.which('setfacl'), 'Install the standard acl utility on the CI runner'
    writer = pwd.getpwnam('daemon')
    reader = pwd.getpwnam('nobody')
    with tempfile.TemporaryDirectory(prefix='atlas-guard-fixture-') as root:
        folder = Path(root); os.chmod(folder, 0o755)
        path = folder / 'lab.sqlite'; make_lab(path)
        os.chown(path, writer.pw_uid, writer.pw_gid); os.chmod(path, 0o640)
        os.chown(folder, writer.pw_uid, writer.pw_gid)
        subprocess.run(['setfacl', '--no-mask', '-m', f'u:{reader.pw_uid}:r--', str(path)], check=True)
        assert not Path(str(path)+'-wal').exists() and not Path(str(path)+'-shm').exists()
        code = """import os,sqlite3,sys;from pathlib import Path
p=Path(sys.argv[1]);assert not os.access(p,os.W_OK);assert not os.access(p.parent,os.W_OK)
db=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True);db.execute('PRAGMA query_only=ON')
try:
 print(db.execute('SELECT count(*) FROM symbols').fetchone()[0])
 try: db.execute('DELETE FROM symbols')
 except sqlite3.OperationalError: pass
 else: raise AssertionError('Reader acquired write capability')
finally: db.close()
"""
        def read():
            return subprocess.run([sys.executable, '-c', code, str(path)], preexec_fn=demote(reader.pw_uid, reader.pw_gid), capture_output=True, text=True)
        before = read()
        assert before.returncode != 0 and 'readonly database' in before.stderr
        original = path.read_bytes()
        child = subprocess.Popen([sys.executable, '-m', 'lab.wal_guard', '--db', str(path), '--reader', reader.pw_name],
                                 preexec_fn=demote(writer.pw_uid, writer.pw_gid), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            ready, _, _ = select.select([child.stdout], [], [], 10)
            line = child.stdout.readline().strip() if ready else 'readiness timed out'
            assert line == 'WAL_READONLY_READY', line
            assert path.read_bytes() == original
            result = read()
            assert result.returncode == 0 and result.stdout.strip() == '3', result.stderr
            sidecars = [Path(str(path)+suffix) for suffix in ('-wal', '-shm')]
            identities = [(p.stat().st_dev, p.stat().st_ino) for p in sidecars]
            write = """import sqlite3,sys
db=sqlite3.connect(sys.argv[1]);db.execute("UPDATE symbols SET name='Changed by real writer' WHERE code='005930'");db.commit();db.execute('PRAGMA wal_checkpoint(TRUNCATE)');db.close()
"""
            subprocess.run([sys.executable, '-c', write, str(path)], preexec_fn=demote(writer.pw_uid, writer.pw_gid), check=True)
            assert [(p.stat().st_dev, p.stat().st_ino) for p in sidecars] == identities
            assert read().returncode == 0
            for p in sidecars:
                acl = subprocess.check_output(['getfacl', '-cpn', str(p)], text=True)
                assert f'user:{reader.pw_uid}:r--' in acl
            assert child.poll() is None
        finally:
            child.terminate(); child.communicate(timeout=5)


def test_guard_sql_is_query_only_and_existing_acl_mask_is_not_widened(tmp_path):
    import pwd
    from lab.wal_guard import WalGuard, GuardUnavailable
    path = tmp_path / 'fixture.sqlite'; make_lab(path)
    os.chmod(path, 0o640)
    keeper = sqlite3.connect(path)
    keeper.execute('SELECT rootpage FROM sqlite_master LIMIT 1').fetchall()
    for suffix in ('-wal', '-shm'):
        subprocess.run(['setfacl', '-m', 'g::rw-,m::r--', str(path)+suffix], check=True)
    guard = WalGuard(path, 'nobody')
    try:
        guard.open()
        with pytest.raises(sqlite3.DatabaseError): guard.db.execute('UPDATE symbols SET active=0')
        with pytest.raises(sqlite3.DatabaseError): guard.db.execute('PRAGMA query_only=OFF')
        assert not guard.db.in_transaction
        guard.check()
        for suffix in ('-wal', '-shm'):
            acl = subprocess.check_output(['getfacl', '-cpn', str(path)+suffix], text=True)
            assert 'group::rw-' in acl and 'mask::r--' in acl
    finally:
        guard.close()
        keeper.close()
