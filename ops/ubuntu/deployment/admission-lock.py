#!/usr/bin/python3
"""Shared cross-process deployment admission gate. Never creates or repairs the lock.

Provision /opt/console-mcp-deploy/admission.lock root:console-mcp mode 0640
before using this protocol. All producers MUST acquire shared admission before
publishing a runnable state; validation MUST retain exclusive admission from
the empty-queue scan through isolated validation completion.
"""
import argparse
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
MAX_SHARED_SECONDS = 90
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
                or st.st_nlink != 1 or st.st_mode & 0o002
                or st.st_mode & 0o111
                or (st.st_dev, st.st_ino) != (named.st_dev, named.st_ino)):
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


def hold_session(mode, *, max_seconds):
    if max_seconds < 1 or max_seconds > (MAX_SHARED_SECONDS if mode == "shared" else MAX_EXCLUSIVE_SECONDS):
        raise AdmissionError("ADMISSION_DURATION_INVALID")
    with admission(mode):
        sys.stdout.write(json.dumps({"ok": True, "status": "ADMISSION_LOCKED", "mode": mode}) + "\n")
        sys.stdout.flush()
        # The parent holds stdin open for the duration of its critical section.
        # Exit promptly if parent exits or the deadline expires.
        until = time.monotonic() + max_seconds
        while True:
            remaining = until - time.monotonic()
            if remaining <= 0:
                break
            ready, _, _ = select.select([sys.stdin], [], [], min(remaining, 1.0))
            if ready:
                chunk = os.read(sys.stdin.fileno(), 4096)
                if not chunk:
                    break
                raise AdmissionError("ADMISSION_UNEXPECTED_INPUT")


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
