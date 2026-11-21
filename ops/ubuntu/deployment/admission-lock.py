#!/usr/bin/python3
"""Shared cross-process deployment admission gate. Never creates or repairs the lock.

Provision /opt/console-mcp-deploy/admission.lock root:console-mcp mode 0640
before using this protocol. All producers MUST acquire shared admission before
publishing a runnable state; validation MUST retain exclusive admission from
the empty-queue scan through isolated validation completion.
"""
import argparse
import secrets
import re
import pwd
import contextlib
import fcntl
import json
import os
from pathlib import Path
import select
import stat
import sys
import time

LOCK_PATH = Path("/opt/console-mcp-deploy/admission.lock")
PARENT = LOCK_PATH.parent
INFLIGHT_DIR = Path('/opt/console-mcp-deploy/admission-inflight')
MAX_SHARED_SECONDS = 2700
MAX_EXCLUSIVE_SECONDS = 1200


class AdmissionError(RuntimeError):
    pass


def trusted_lock(path=LOCK_PATH, *, expected_uid=0):
    parent = path.parent
    pst = parent.lstat()
    if not stat.S_ISDIR(pst.st_mode) or pst.st_uid != expected_uid or (pst.st_mode & 0o022):
        raise AdmissionError("ADMISSION_PARENT_UNTRUSTED")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    try:
        st = os.fstat(fd)
        named = path.lstat()
        if (not stat.S_ISREG(st.st_mode) or st.st_uid != expected_uid
                or st.st_nlink != 1 or st.st_mode & 0o022
                or st.st_mode & 0o111
                or (st.st_dev, st.st_ino) != (named.st_dev, named.st_ino)
                or (path == LOCK_PATH
                    and (st.st_gid != pwd.getpwnam('console-mcp').pw_gid
                         or stat.S_IMODE(st.st_mode) != 0o640))):
            raise AdmissionError("ADMISSION_LOCK_UNTRUSTED")
        return fd
    except BaseException:
        os.close(fd)
        raise


@contextlib.contextmanager
def admission(mode, path=LOCK_PATH, *, timeout=15, expected_uid=0):
    if mode not in ("shared", "exclusive"):
        raise ValueError("ADMISSION_MODE_INVALID")
    fd = trusted_lock(path, expected_uid=expected_uid)
    flag = fcntl.LOCK_SH if mode == "shared" else fcntl.LOCK_EX
    deadline = time.monotonic() + timeout
    try:
        while True:
            try:
                fcntl.flock(fd, flag | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise AdmissionError("ADMISSION_BUSY")
                time.sleep(0.025)
        # If path changed after open/lock, do not accept a different inode.
        stat_fd = os.fstat(fd)
        stat_path = path.lstat()
        if (stat_fd.st_dev, stat_fd.st_ino) != (stat_path.st_dev, stat_path.st_ino):
            raise AdmissionError("ADMISSION_LOCK_CHANGED")
        yield
    finally:
        os.close(fd)  # POSIX releases flock on process exit and close.



def trusted_inflight_dir(directory=INFLIGHT_DIR, *, expected_uid=None):
    if expected_uid is None:
        expected_uid = pwd.getpwnam('console-mcp').pw_uid if os.geteuid() == 0 else os.geteuid()
    parent = directory.parent
    pst = parent.lstat()
    parent_owner = 0 if directory == INFLIGHT_DIR else expected_uid
    if (not stat.S_ISDIR(pst.st_mode) or pst.st_uid != parent_owner
            or pst.st_mode & 0o022):
        raise AdmissionError("ADMISSION_INFLIGHT_PARENT_UNTRUSTED")
    st = directory.lstat()
    if (not stat.S_ISDIR(st.st_mode) or st.st_uid != expected_uid
            or st.st_mode & 0o077 or st.st_nlink < 2):
        raise AdmissionError("ADMISSION_INFLIGHT_DIRECTORY_UNTRUSTED")
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    actual = os.fstat(fd)
    if (actual.st_dev, actual.st_ino) != (st.st_dev, st.st_ino):
        os.close(fd)
        raise AdmissionError("ADMISSION_INFLIGHT_DIRECTORY_CHANGED")
    return fd


def assert_inflight_empty(directory=INFLIGHT_DIR, *, expected_uid=None):
    fd = trusted_inflight_dir(directory, expected_uid=expected_uid)
    try:
        entries = os.listdir(fd)
        # No stale-marker cleanup in the release path; even malformed entries
        # block validation until a separate operator-led reconciliation.
        if entries:
            raise AdmissionError("ADMISSION_INFLIGHT_NOT_EMPTY")
    finally:
        os.close(fd)


def create_inflight(directory=INFLIGHT_DIR, *, expected_uid=None):
    fd = trusted_inflight_dir(directory, expected_uid=expected_uid)
    name = secrets.token_hex(24) + ".json"
    try:
        marker_fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                            0o600, dir_fd=fd)
        try:
            record = json.dumps({"schemaVersion": 1, "pid": os.getpid(), "nonce": name[:-5]}) + "\n"
            os.write(marker_fd, record.encode("utf8"))
            os.fsync(marker_fd)
        finally:
            os.close(marker_fd)
        os.fsync(fd)
        return fd, name
    except BaseException:
        os.close(fd)
        raise


def release_inflight(fd, name):
    # Release only on an explicit successful callback completion handshake,
    # while the shared flock is STILL held.
    os.unlink(name, dir_fd=fd)
    os.fsync(fd)


def hold_session(mode, *, max_seconds, directory=INFLIGHT_DIR, lock_path=LOCK_PATH, expected_uid=0):
    if max_seconds < 1 or max_seconds > (MAX_SHARED_SECONDS if mode == "shared" else MAX_EXCLUSIVE_SECONDS):
        raise AdmissionError("ADMISSION_DURATION_INVALID")
    # The admission.lock is root-owned, but durable markers are service-owned.
    # Keep these two identity boundaries independent under the real mixed-UID
    # install; in fixture mode both are test-owned.
    marker_uid = pwd.getpwnam('console-mcp').pw_uid if directory == INFLIGHT_DIR else os.geteuid()
    with admission(mode, lock_path, expected_uid=expected_uid):
        if mode == "exclusive":
            assert_inflight_empty(directory, expected_uid=marker_uid)
            sys.stdout.write(json.dumps({"ok": True, "status": "ADMISSION_LOCKED", "mode": mode}) + "\n")
            sys.stdout.flush()
            return
        directory_fd, name = create_inflight(directory, expected_uid=marker_uid)
        try:
            sys.stdout.write(json.dumps({"ok": True, "status": "ADMISSION_LOCKED",
                                         "mode": mode, "nonce": name[:-5]}) + "\n")
            sys.stdout.flush()
            # EOF, timeout, crash or protocol error never deletes the marker.
            until = time.monotonic() + max_seconds
            line = b""
            while True:
                remaining = until - time.monotonic()
                if remaining <= 0:
                    raise AdmissionError("ADMISSION_SESSION_TIMEOUT_FENCE_RETAINED")
                ready, _, _ = select.select([sys.stdin], [], [], min(remaining, 1.0))
                if not ready:
                    continue
                chunk = os.read(sys.stdin.fileno(), 256)
                if not chunk:
                    raise AdmissionError("ADMISSION_SESSION_LOST_FENCE_RETAINED")
                line += chunk
                if len(line) > 128:
                    raise AdmissionError("ADMISSION_RELEASE_FRAME_TOO_LARGE")
                if b"\n" in line:
                    break
            if line != ("RELEASE " + name[:-5] + "\n").encode():
                raise AdmissionError("ADMISSION_RELEASE_FRAME_INVALID")
            release_inflight(directory_fd, name)
            sys.stdout.write(json.dumps({"ok": True, "status": "ADMISSION_RELEASED",
                                         "nonce": name[:-5]}) + "\n")
            sys.stdout.flush()
        finally:
            os.close(directory_fd)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("shared", "exclusive"))
    parser.add_argument("--max-seconds", type=int, required=True)
    args = parser.parse_args()
    try:
        hold_session(args.mode, max_seconds=args.max_seconds)
    except (AdmissionError, OSError) as error:
        print(json.dumps({"ok": False, "status": str(error)}), file=sys.stderr)
        raise SystemExit(2)


if __name__ == "__main__":
    main()
