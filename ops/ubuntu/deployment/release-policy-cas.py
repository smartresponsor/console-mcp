#!/usr/bin/python3
"""Atomic root-owned broker policy CAS using no-follow dirfd operations."""
import fcntl
import hashlib
import json
import math
import os
import re
import secrets
import stat
from pathlib import Path
import time


class PolicyConflict(RuntimeError):
    pass


def generation(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _trusted_directory_stat(metadata: os.stat_result) -> bool:
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 0:
        return False
    if metadata.st_mode & 0o022:
        # Permit only root-owned sticky shared directories such as /tmp.
        return bool(metadata.st_mode & stat.S_ISVTX)
    return True


def _open_directory_chain(path: Path) -> int:
    """Open an absolute directory chain without following symlinks.

    Every ancestor must be root-owned and not group/other writable, except a
    root-owned sticky directory (e.g. /tmp). Returned dirfd anchors operations
    against later pathname replacement.
    """
    if not path.is_absolute() or ".." in path.parts:
        raise RuntimeError("RELEASE_POLICY_DIRECTORY_PATH_INVALID")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
    fd = os.open("/", flags)
    try:
        if not _trusted_directory_stat(os.fstat(fd)):
            raise RuntimeError("RELEASE_POLICY_UNTRUSTED_DIRECTORY:/")
        for component in path.parts[1:]:
            if component in ("", "."):
                continue
            child = os.open(component, flags, dir_fd=fd)
            try:
                if not _trusted_directory_stat(os.fstat(child)):
                    raise RuntimeError(f"RELEASE_POLICY_UNTRUSTED_DIRECTORY:{component}")
            except BaseException:
                os.close(child)
                raise
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def _open_parent(path: Path) -> tuple[int, str]:
    if not path.is_absolute() or path.name in ("", ".", ".."):
        raise RuntimeError("RELEASE_POLICY_PATH_INVALID")
    return _open_directory_chain(path.parent), path.name


def _open_regular_at(directory_fd: int, name: str, flags: int) -> int:
    fd = os.open(name, flags | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=directory_fd)
    metadata = os.fstat(fd)
    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0
            or metadata.st_mode & 0o077):
        os.close(fd)
        raise RuntimeError("RELEASE_POLICY_UNTRUSTED_PATH")
    return fd


def _read_regular_at(directory_fd: int, name: str) -> bytes:
    fd = _open_regular_at(directory_fd, name, os.O_RDONLY)
    try:
        chunks = []
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                return b"".join(chunks)
            chunks.append(chunk)
    finally:
        os.close(fd)


def inspect(path: Path) -> dict:
    directory_fd, name = _open_parent(path)
    try:
        raw = _read_regular_at(directory_fd, name)
    finally:
        os.close(directory_fd)
    return {"generation": generation(raw), "policy": json.loads(raw)}


def _same_inode_at(directory_fd: int, name: str, fd: int) -> bool:
    opened = os.fstat(fd)
    named = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    return (opened.st_dev, opened.st_ino) == (named.st_dev, named.st_ino)


def _validate_policy(new_policy: dict) -> None:
    if not isinstance(new_policy, dict) or new_policy.get("schemaVersion") != 1:
        raise ValueError("RELEASE_POLICY_SCHEMA_INVALID")
    if (not isinstance(new_policy.get("authorizedSha"), str)
            or not re.fullmatch(r"[0-9a-f]{40}", new_policy["authorizedSha"])):
        raise ValueError("RELEASE_POLICY_AUTHORIZATION_INVALID")
    enabled = new_policy.get("enabledOperations")
    if not isinstance(enabled, list) or not all(
            isinstance(op, str) and op in ("prepare", "validate", "activate", "rollback")
            for op in enabled):
        raise ValueError("RELEASE_POLICY_OPERATIONS_INVALID")


def _validate_existing_policy(raw: bytes) -> dict:
    old = json.loads(raw)
    if not isinstance(old, dict) or old.get("schemaVersion") != 1:
        raise RuntimeError("RELEASE_POLICY_SCHEMA_INVALID")
    lease = old.get("authorizationLease")
    if lease is not None and (
            not isinstance(lease, dict)
            or not isinstance(lease.get("owner"), str)
            or type(lease.get("expiresAt")) not in (int, float)
            or not math.isfinite(lease["expiresAt"])):
        raise RuntimeError("RELEASE_POLICY_LEASE_INVALID")
    return old


def _write_atomic_at(directory_fd: int, target_name: str, encoded: bytes) -> None:
    temporary_name = f".broker-policy-{os.getpid()}-{secrets.token_hex(12)}"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW
    fd = os.open(temporary_name, flags, 0o600, dir_fd=directory_fd)
    try:
        with os.fdopen(fd, "wb", closefd=False) as output:
            output.write(encoded)
            output.flush()
            os.fsync(fd)
        os.replace(temporary_name, target_name,
                   src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
        os.fsync(directory_fd)
    finally:
        try:
            os.unlink(temporary_name, dir_fd=directory_fd)
        except FileNotFoundError:
            pass
        os.close(fd)


def replace_if_generation(path: Path, lock_path: Path, expected_generation: str,
                          owner: str, lease_seconds: int, new_policy: dict,
                          now: float | None = None) -> dict:
    """Update a root-owned policy atomically under a dirfd-anchored CAS lock."""
    if (not isinstance(owner, str) or not owner
            or type(lease_seconds) not in (int, float)
            or not math.isfinite(lease_seconds) or not (1 <= lease_seconds <= 3600)):
        raise ValueError("RELEASE_POLICY_OWNER_OR_LEASE_INVALID")
    if (not isinstance(expected_generation, str)
            or re.fullmatch(r"[0-9a-f]{64}", expected_generation) is None):
        raise ValueError("RELEASE_POLICY_GENERATION_INVALID")
    _validate_policy(new_policy)
    if (not path.is_absolute() or not lock_path.is_absolute()
            or Path(os.path.normpath(str(path.parent))) != Path(os.path.normpath(str(lock_path.parent)))):
        raise ValueError("RELEASE_POLICY_PATH_INVALID")
    now = time.time() if now is None else now
    directory_fd, policy_name = _open_parent(path)
    lock_name = lock_path.name
    if (lock_name in ("", ".", "..") or policy_name in ("", ".", "..")
            or lock_name == policy_name):
        os.close(directory_fd)
        raise ValueError("RELEASE_POLICY_PATH_INVALID")
    try:
        lock_flags = os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW
        lock_fd = os.open(lock_name, lock_flags, 0o600, dir_fd=directory_fd)
        try:
            lock_metadata = os.fstat(lock_fd)
            if (not stat.S_ISREG(lock_metadata.st_mode) or lock_metadata.st_uid != 0
                    or lock_metadata.st_mode & 0o077):
                raise RuntimeError("RELEASE_POLICY_UNTRUSTED_PATH")
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            if not _same_inode_at(directory_fd, lock_name, lock_fd):
                raise RuntimeError("RELEASE_POLICY_LOCK_REPLACED")
            policy_metadata = os.stat(policy_name, dir_fd=directory_fd, follow_symlinks=False)
            if (not stat.S_ISREG(policy_metadata.st_mode) or policy_metadata.st_uid != 0
                    or policy_metadata.st_mode & 0o077):
                raise RuntimeError("RELEASE_POLICY_UNTRUSTED_PATH")
            if (policy_metadata.st_dev, policy_metadata.st_ino) == (
                    lock_metadata.st_dev, lock_metadata.st_ino):
                raise RuntimeError("RELEASE_POLICY_LOCK_ALIASED")
            current = _read_regular_at(directory_fd, policy_name)
            if generation(current) != expected_generation:
                raise PolicyConflict("RELEASE_POLICY_GENERATION_CONFLICT")
            old = _validate_existing_policy(current)
            lease = old.get("authorizationLease")
            if (isinstance(lease, dict) and lease.get("owner") != owner
                    and lease.get("expiresAt") > now):
                raise PolicyConflict("RELEASE_POLICY_LEASE_HELD")
            updated = dict(new_policy)
            updated["authorizationLease"] = {
                "owner": owner, "expiresAt": now + lease_seconds}
            encoded = (json.dumps(updated, indent=2, sort_keys=True) + "\n").encode()
            _write_atomic_at(directory_fd, policy_name, encoded)
            return {"generation": generation(encoded), "owner": owner,
                    "expiresAt": now + lease_seconds}
        finally:
            os.close(lock_fd)
    finally:
        os.close(directory_fd)
