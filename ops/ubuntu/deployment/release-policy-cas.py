#!/usr/bin/python3
"""Atomic, root-owned broker authorization policy updates.

This module does not grant authorization on its own. The release broker must
explicitly integrate its compare-and-swap contract before production use.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time


class PolicyConflict(RuntimeError):
    pass


def generation(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def inspect(path: Path) -> dict:
    raw = path.read_bytes()
    data = json.loads(raw)
    return {"generation": generation(raw), "policy": data}


def replace_if_generation(path: Path, lock_path: Path, expected_generation: str,
                          owner: str, lease_seconds: int, new_policy: dict,
                          now: float | None = None) -> dict:
    """Update only under an exclusive lock and exact generation match.

    Caller must be an authorized administrator. The file must already exist,
    be regular, root-owned and inaccessible to group/others. Fail closed.
    """
    if not owner or not isinstance(owner, str) or not (1 <= lease_seconds <= 3600):
        raise ValueError("RELEASE_POLICY_OWNER_OR_LEASE_INVALID")
    if not isinstance(expected_generation, str) or len(expected_generation) != 64:
        raise ValueError("RELEASE_POLICY_GENERATION_INVALID")
    if new_policy.get("schemaVersion") != 1:
        raise ValueError("RELEASE_POLICY_SCHEMA_INVALID")
    now = time.time() if now is None else now
    with open(lock_path, "a+b") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        st = path.lstat()
        if not path.is_file() or path.is_symlink() or st.st_uid != 0 or (st.st_mode & 0o077):
            raise RuntimeError("RELEASE_POLICY_UNTRUSTED_PATH")
        current = path.read_bytes()
        if generation(current) != expected_generation:
            raise PolicyConflict("RELEASE_POLICY_GENERATION_CONFLICT")
        old = json.loads(current)
        lease = old.get("authorizationLease")
        if isinstance(lease, dict) and lease.get("owner") != owner and lease.get("expiresAt", 0) > now:
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
