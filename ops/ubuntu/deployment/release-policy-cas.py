#!/usr/bin/python3
"""Atomic, root-owned broker authorization policy updates.

This module does not grant authorization on its own. The release broker must
explicitly integrate its compare-and-swap contract before production use.
"""
import fcntl
import hashlib
import json
import os
import re
import stat
from pathlib import Path
import tempfile
import time


class PolicyConflict(RuntimeError):
    pass


def generation(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def inspect(path: Path) -> dict:
    _trusted_regular(path)
    raw = path.read_bytes()
    data = json.loads(raw)
    return {"generation": generation(raw), "policy": data}


def _trusted_regular(path: Path) -> None:
    st = path.lstat()
    if (not stat.S_ISREG(st.st_mode) or st.st_uid != 0
            or (st.st_mode & 0o077) != 0):
        raise RuntimeError("RELEASE_POLICY_UNTRUSTED_PATH")


def _trusted_directory(path: Path) -> None:
    st = path.lstat()
    if (not stat.S_ISDIR(st.st_mode) or st.st_uid != 0
            or (st.st_mode & 0o022) != 0):
        raise RuntimeError("RELEASE_POLICY_UNTRUSTED_DIRECTORY")


def replace_if_generation(path: Path, lock_path: Path, expected_generation: str,
                          owner: str, lease_seconds: int, new_policy: dict,
                          now: float | None = None) -> dict:
    """Update only under an exclusive lock and exact generation match.

    Caller must be an authorized administrator. The file must already exist,
    be regular, root-owned and inaccessible to group/others. Fail closed.
    """
    if not owner or not isinstance(owner, str) or not (1 <= lease_seconds <= 3600):
        raise ValueError("RELEASE_POLICY_OWNER_OR_LEASE_INVALID")
    if not isinstance(expected_generation, str) or re.fullmatch(r"[0-9a-f]{64}", expected_generation) is None:
        raise ValueError("RELEASE_POLICY_GENERATION_INVALID")
    if not isinstance(new_policy, dict) or new_policy.get("schemaVersion") != 1:
        raise ValueError("RELEASE_POLICY_SCHEMA_INVALID")
    now = time.time() if now is None else now
    _trusted_directory(path.parent)
    _trusted_directory(lock_path.parent)
    _trusted_regular(path)
    flags = os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW
    fd = os.open(lock_path, flags, 0o600)
    with os.fdopen(fd, "r+b") as lock:
        _trusted_regular(lock_path)
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        _trusted_regular(lock_path)
        locked = os.fstat(lock.fileno())
        named = lock_path.lstat()
        if (locked.st_dev, locked.st_ino) != (named.st_dev, named.st_ino):
            raise RuntimeError("RELEASE_POLICY_LOCK_REPLACED")
        _trusted_regular(path)
        current = path.read_bytes()
        if generation(current) != expected_generation:
            raise PolicyConflict("RELEASE_POLICY_GENERATION_CONFLICT")
        old = json.loads(current)
        lease = old.get("authorizationLease")
        if lease is not None and (not isinstance(lease, dict)
                                  or not isinstance(lease.get("owner"), str)
                                  or type(lease.get("expiresAt")) not in (int, float)):
            raise RuntimeError("RELEASE_POLICY_LEASE_INVALID")
        if isinstance(lease, dict) and lease.get("owner") != owner and lease.get("expiresAt") > now:
            raise PolicyConflict("RELEASE_POLICY_LEASE_HELD")
        updated = dict(new_policy)
        updated["authorizationLease"] = {"owner": owner, "expiresAt": now + lease_seconds}
        encoded = (json.dumps(updated, indent=2, sort_keys=True) + "\n").encode()
        fd, tmp = tempfile.mkstemp(prefix=".broker-policy-", dir=path.parent)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "wb") as output:
                output.write(encoded)
                output.flush()
                os.fsync(output.fileno())
            os.replace(tmp, path)
            dirfd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(dirfd)
            finally:
                os.close(dirfd)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
        return {"generation": generation(encoded), "owner": owner, "expiresAt": now + lease_seconds}
