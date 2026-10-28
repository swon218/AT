"""Read-only physical commit fingerprint, independent of PRAGMA data_version.

Formats: https://sqlite.org/fileformat.html and https://sqlite.org/walformat.html
Raw file reads run in a separate process: closing a raw DB descriptor in the
SQLite process can cancel its POSIX advisory locks (sqlite.org/howtocorrupt.html).
No SQLite import, checkpoint, locks, file writes or credentials in that helper.
"""
import hashlib
import atexit
from concurrent.futures import ThreadPoolExecutor, TimeoutError
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
from threading import Lock
import time

FORMAT = 'sqlite-physical-commit-v1'
TIMEOUT = 2.0


class FingerprintUnavailable(Exception):
    pass


def _checksum(data, order, seed=(0, 0)):
    a, b = seed
    words = struct.unpack(order + 'I' * (len(data) // 4), data)
    for i in range(0, len(words), 2):
        a = (a + words[i] + b) & 0xffffffff
        b = (b + words[i + 1] + a) & 0xffffffff
    return a, b


def _index_header(raw):
    if len(raw) != 96 or raw[:48] != raw[48:]:
        raise FingerprintUnavailable('index_unstable')
    h = raw[:48]
    if (struct.unpack('=I', h[:4])[0] != 3007000 or h[12] != 1 or
            _checksum(h[:40], '=') != struct.unpack('=II', h[40:48])):
        raise FingerprintUnavailable('index_unverified')
    page_size = struct.unpack('=H', h[14:16])[0]
    return h, 65536 if page_size == 1 else page_size


def _stat(st):
    return st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns


def _wal(path, page_size):
    try:
        handle = open(str(path) + '-wal', 'rb')
    except FileNotFoundError:
        return None
    with handle as wal:
        stamp = _stat(os.fstat(wal.fileno()))
        if stamp[2] == 0:
            return None
        header = wal.read(32)
        if len(header) != 32:
            raise FingerprintUnavailable('wal_unstable')
        magic, version, size = struct.unpack('>III', header[:12])
        if magic not in (0x377f0682, 0x377f0683) or version != 3007000 or size != page_size:
            raise FingerprintUnavailable('wal_unverified')
        order = '>' if magic & 1 else '<'
        if _checksum(header[:24], order) != struct.unpack('>II', header[24:32]):
            raise FingerprintUnavailable('wal_unverified')
        if stamp[2] == 32:
            return None  # No frames: opening an empty WAL is not a data commit.
        with open(str(path) + '-shm', 'rb') as shm:
            raw = shm.read(96)
        index, indexed_size = _index_header(raw)
        frames, pages = struct.unpack('=II', index[16:24])
        if frames == 0:
            return None  # A retained/preallocated WAL can contain only stale frames.
        if indexed_size != page_size or index[32:40] != header[16:24] or index[13] != (magic & 1):
            raise FingerprintUnavailable('wal_index_mismatch')
        offset = 32 + (frames - 1) * (page_size + 24)
        if offset + 24 + page_size > stamp[2]:
            raise FingerprintUnavailable('wal_unstable')
        wal.seek(offset)
        frame, page = wal.read(24), wal.read(page_size)
        if (len(page) != page_size or len(frame) != 24 or frame[8:16] != header[16:24] or
                struct.unpack('>I', frame[:4])[0] == 0 or struct.unpack('>I', frame[4:8])[0] != pages or
                pages == 0 or struct.unpack('>II', frame[16:24]) != struct.unpack('=II', index[24:32])):
            raise FingerprintUnavailable('commit_unverified')
        if frames == 1:
            seed = struct.unpack('>II', header[24:32])
        else:
            wal.seek(offset - (page_size + 24))
            previous = wal.read(24)
            if previous[8:16] != header[16:24]:
                raise FingerprintUnavailable('commit_unverified')
            seed = struct.unpack('>II', previous[16:24])
        if _checksum(frame[:8] + page, order, seed) != struct.unpack('>II', frame[16:24]):
            raise FingerprintUnavailable('commit_unverified')
        if stamp != _stat(os.fstat(wal.fileno())):
            raise FingerprintUnavailable('wal_unstable')
        # iChange, SHM checksums, read marks and checkpoint counters are deliberately
        # absent. They can change without a new committed data snapshot.
        return stamp, header.hex(), frames, pages, frame.hex(), hashlib.sha256(page).hexdigest()


def _sample(path):
    with open(path, 'rb') as db:
        stamp = _stat(os.fstat(db.fileno()))
        header = db.read(100)
    if len(header) != 100 or header[:16] != b'SQLite format 3\x00':
        raise FingerprintUnavailable('db_unverified')
    page_size = struct.unpack('>H', header[16:18])[0]
    page_size = 65536 if page_size == 1 else page_size
    if page_size < 512 or page_size > 65536 or page_size & (page_size - 1):
        raise FingerprintUnavailable('db_unverified')
    if header[18:20] != b'\x02\x02':
        raise FingerprintUnavailable('wal_mode_required')
    wal = _wal(path, page_size)
    if stamp != _stat(path.stat()):
        raise FingerprintUnavailable('db_unstable')
    return stamp, header.hex(), wal


def _probe(path):
    reason = 'snapshot_unstable'
    for _ in range(3):
        try:
            first, second = _sample(path), _sample(path)
            if first == second:
                token = hashlib.sha256(json.dumps([FORMAT, first], separators=(',', ':')).encode()).hexdigest()
                return {'format': FORMAT, 'token': token, 'wal_committed_frames': first[2][2] if first[2] else 0}
        except FingerprintUnavailable as exc:
            reason = str(exc)
            continue
        except FileNotFoundError:
            reason = 'wal_index_missing'
            continue
    raise FingerprintUnavailable(reason)


class FingerprintReader:
    """One reusable, bounded stdlib-only helper; no raw file opens in its parent."""
    def __init__(self):
        self.lock, self.process = Lock(), None
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='atlas-db-fingerprint')

    def _stop(self):
        process, self.process = self.process, None
        if process is not None:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=0.5)
            process.stdin.close(); process.stdout.close()

    def close(self):
        with self.lock:
            self._stop()
        self.executor.shutdown(wait=False, cancel_futures=True)

    def __call__(self, path, timeout=TIMEOUT):
        if not self.lock.acquire(timeout=min(0.1, timeout)):
            raise FingerprintUnavailable('fingerprint_busy')
        try:
            deadline = time.monotonic() + timeout
            if self.process is None or self.process.poll() is not None:
                self._stop()
                # -I -S prevents inherited startup hooks/site packages. Do not pass
                # AI, broker or Supabase secrets to the read-only helper.
                environment = {key: os.environ[key] for key in ('SystemRoot', 'WINDIR') if key in os.environ}
                self.process = subprocess.Popen([sys.executable, '-I', '-S', str(Path(__file__).resolve()), '--serve'],
                                                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                                stderr=subprocess.DEVNULL, env=environment, bufsize=0)
            self.process.stdin.write((json.dumps({'path': str(path)}) + '\n').encode())
            self.process.stdin.flush()
            future = self.executor.submit(self.process.stdout.readline, 2048)
            raw = future.result(timeout=max(0.001, deadline - time.monotonic()))
            value = json.loads(raw)
            token = value.get('token', '')
            if value.get('format') != FORMAT or len(token) != 64 or any(c not in '0123456789abcdef' for c in token):
                raise FingerprintUnavailable('snapshot_unverified')
            return token
        except TimeoutError:
            self._stop()
            raise FingerprintUnavailable('fingerprint_timeout') from None
        except (OSError, ValueError, TypeError):
            self._stop()
            raise FingerprintUnavailable('fingerprint_unavailable') from None
        finally:
            self.lock.release()


fingerprint = FingerprintReader()
atexit.register(fingerprint.close)


if __name__ == '__main__':
    def answer(path):
        try:
            return _probe(Path(path).resolve())
        except FingerprintUnavailable as exc:
            return {'error': str(exc)}  # Only fixed format/state codes, never paths/rows.
        except PermissionError:
            return {'error': 'fingerprint_permission_denied'}
        except (OSError, ValueError):
            return {'error': 'snapshot_unverified'}
    if len(sys.argv) == 2 and sys.argv[1] == '--serve':
        for line in sys.stdin.buffer:
            try:
                response = answer(json.loads(line)['path'])
            except (ValueError, TypeError, KeyError):
                response = {'error': 'snapshot_unverified'}
            print(json.dumps(response), flush=True)
    else:
        response = answer(sys.argv[1]) if len(sys.argv) == 2 else {'error': 'snapshot_unverified'}
        print(json.dumps(response))
        sys.exit(1 if 'error' in response else 0)
