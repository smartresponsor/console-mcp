#!/usr/bin/python3
"""Stage 08 exact-SHA prepare authorization. Install as root-owned reviewed code.

Only an independently authenticated root administrator may run --apply.
This tool NEVER invokes prepare, seal, validate, activate, rollback or systemctl.
"""
import argparse
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import time

SHA = "eb5e062023cb40341fc75b56ce26524a9a529f16"
TREE = "df029f570d423a11ff8465ff3a4d8e13b9614fd8"
SOURCE = Path("/home/alex/smartresponse/mcp/.worktrees/.worktrees/stage08-immutable-eb5e-20261118")
BASE = Path("/opt/console-mcp-deploy")
POLICY = BASE / "broker-policy.json"
LOCK = BASE / "broker.lock"
ALLOWED_KEYS = frozenset(("schemaVersion", "authorizedSha", "sourcePath", "enabledOperations", "authorizationLease"))
LEASE_OWNER = "stage08-exact-sha-prepare"
LEASE_SECONDS = 900


def require_dir(path, uid=0):
    st = path.lstat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != uid or (st.st_mode & 0o022):
        raise RuntimeError("UNTRUSTED_DIRECTORY:" + str(path))


def open_trusted(path, uid=0):
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    st = os.fstat(fd)
    named = path.lstat()
    if (not stat.S_ISREG(st.st_mode) or st.st_uid != uid or
            st.st_mode & 0o077 or (st.st_dev, st.st_ino) != (named.st_dev, named.st_ino)):
        os.close(fd)
        raise RuntimeError("UNTRUSTED_POLICY_FILE")
    return fd


def git(*args):
    command = ["/usr/bin/git", "-c", "safe.directory=" + str(SOURCE), "-C", str(SOURCE), *args]
    p = subprocess.run(command, capture_output=True, text=True, timeout=20,
                       env={"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "GIT_OPTIONAL_LOCKS": "0"})
    if p.returncode:
        raise RuntimeError("GIT_PROVENANCE_FAILED:" + " ".join(args))
    return p.stdout.strip()


def source_attestation():
    if SOURCE.is_symlink() or SOURCE.resolve(strict=True) != SOURCE:
        raise RuntimeError("SOURCE_PATH_UNTRUSTED")
    st = SOURCE.lstat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid == 0 or (st.st_mode & 0o002):
        raise RuntimeError("SOURCE_OWNERSHIP_INVALID")
    if git("rev-parse", "HEAD") != SHA:
        raise RuntimeError("SOURCE_SHA_MISMATCH")
    if git("rev-parse", "HEAD^{tree}") != TREE:
        raise RuntimeError("SOURCE_TREE_MISMATCH")
    if git("rev-parse", "refs/remotes/origin/master") != SHA:
        raise RuntimeError("LOCAL_MASTER_NOT_PINNED")
    if git("status", "--porcelain=v1", "--untracked-files=normal"):
        raise RuntimeError("SOURCE_NOT_CLEAN")
    return {"sha": SHA, "tree": TREE, "source": str(SOURCE)}


def inspect_policy():
    require_dir(BASE)
    fd = open_trusted(POLICY)
    with os.fdopen(fd, "rb") as f:
        data = f.read(65537)
    if len(data) > 65536:
        raise RuntimeError("POLICY_TOO_LARGE")
    decoded = json.loads(data)
    if not isinstance(decoded, dict) or decoded.get("schemaVersion") != 1:
        raise RuntimeError("POLICY_SCHEMA_INVALID")
    if set(decoded) - ALLOWED_KEYS:
        raise RuntimeError("POLICY_UNKNOWN_KEYS")
    return data, decoded, hashlib.sha256(data).hexdigest()


def proposed(current, now):
    old_lease = current.get("authorizationLease")
    if old_lease is not None:
        if (not isinstance(old_lease, dict) or
            not isinstance(old_lease.get("owner"), str) or
            type(old_lease.get("expiresAt")) not in (int, float) or
            not math.isfinite(old_lease["expiresAt"])):
            raise RuntimeError("OLD_LEASE_INVALID")
        if old_lease["expiresAt"] > now and old_lease["owner"] != LEASE_OWNER:
            raise RuntimeError("ACTIVE_FOREIGN_LEASE")
    # No privilege inheritance: never copy old enabledOperations.
    return {
        "schemaVersion": 1,
        "authorizedSha": SHA,
        "sourcePath": str(SOURCE),
        "enabledOperations": ["prepare"],
        "authorizationLease": {"owner": LEASE_OWNER, "expiresAt": now + LEASE_SECONDS},
    }


def authorize(policy, lock, expected, *, uid=0, now=None):
    if not re.fullmatch("[0-9a-f]{64}", expected):
        raise RuntimeError("EXPECTED_GENERATION_INVALID")
    now = time.time() if now is None else now
    require_dir(policy.parent, uid)
    require_dir(lock.parent, uid)
    lockfd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    try:
        lst = os.fstat(lockfd)
        named = lock.lstat()
        if (not stat.S_ISREG(lst.st_mode) or lst.st_uid != uid or lst.st_mode & 0o077 or
            (lst.st_dev, lst.st_ino) != (named.st_dev, named.st_ino)):
            raise RuntimeError("LOCK_PATH_UNTRUSTED")
        fcntl.flock(lockfd, fcntl.LOCK_EX)
        # Compare and backup must be inside the same locked critical section.
        fd = open_trusted(policy, uid)
        with os.fdopen(fd, "rb") as h:
            raw = h.read(65537)
        if len(raw) > 65536 or hashlib.sha256(raw).hexdigest() != expected:
            raise RuntimeError("POLICY_GENERATION_CONFLICT")
        current = json.loads(raw)
        if (not isinstance(current, dict) or current.get("schemaVersion") != 1 or
            set(current) - ALLOWED_KEYS):
            raise RuntimeError("POLICY_SCHEMA_INVALID")
        updated = proposed(current, now)
        encoded = (json.dumps(updated, sort_keys=True, indent=2) + "\n").encode()
        stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(now))
        backup = policy.parent / ("broker-policy.stage08." + stamp + "." + expected[:12] + ".bak")
        bfd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(bfd, "wb") as b:
                b.write(raw)
                b.flush()
                os.fsync(b.fileno())
        except BaseException:
            try:
                backup.unlink()
            except OSError:
                pass
            raise
        tempfd, tmp = tempfile.mkstemp(prefix=".stage08-policy-", dir=policy.parent)
        try:
            os.fchmod(tempfd, 0o600)
            with os.fdopen(tempfd, "wb") as t:
                t.write(encoded)
                t.flush()
                os.fsync(t.fileno())
            # No late source or policy changes between original preflight and CAS.
            currentfd = open_trusted(policy, uid)
            with os.fdopen(currentfd, "rb") as h:
                if hashlib.sha256(h.read()).hexdigest() != expected:
                    raise RuntimeError("POLICY_GENERATION_CONFLICT")
            os.replace(tmp, policy)
            dirfd = os.open(policy.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(dirfd)
            finally:
                os.close(dirfd)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
        return {"status": "PREPARE_ONLY_AUTHORIZED",
                "generation": hashlib.sha256(encoded).hexdigest(),
                "backup": str(backup), "expiresAt": updated["authorizationLease"]["expiresAt"]}
    finally:
        os.close(lockfd)


def main():
    parser = argparse.ArgumentParser()
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--inspect", action="store_true")
    action.add_argument("--apply", action="store_true")
    parser.add_argument("--expected-generation", default="")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit("ADMIN_ROOT_SESSION_REQUIRED")
    attestation = source_attestation()
    raw, current, generation = inspect_policy()
    if args.inspect:
        print(json.dumps({"status": "READ_ONLY", "source": attestation,
                          "policyGeneration": generation,
                          "currentAuthorizedSha": current.get("authorizedSha"),
                          "currentOperations": current.get("enabledOperations", []),
                          "currentSourcePath": current.get("sourcePath"),
                          "lease": current.get("authorizationLease")}, sort_keys=True))
        return
    if not args.expected_generation:
        raise SystemExit("EXPLICIT_POLICY_GENERATION_REQUIRED")
    if generation != args.expected_generation:
        raise SystemExit("POLICY_GENERATION_CONFLICT")
    # Reattest immediately before the locked policy mutation.
    source_attestation()
    receipt = authorize(POLICY, LOCK, args.expected_generation)
    print(json.dumps(receipt, sort_keys=True))


if __name__ == "__main__":
    main()
