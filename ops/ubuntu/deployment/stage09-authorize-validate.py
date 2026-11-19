#!/usr/bin/python3
"""Stage 09 exact-SHA validation authorization. Install as root-owned reviewed code.

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
import runpy
import subprocess
import tempfile
import time

SHA = "eb5e062023cb40341fc75b56ce26524a9a529f16"
TREE = "df029f570d423a11ff8465ff3a4d8e13b9614fd8"
SOURCE = Path("/home/alex/smartresponse/mcp/.worktrees/.worktrees/stage08-immutable-eb5e-20261118")
ROLLBACK = "df90d4706bf3c476ddcf9ef6ba09f6be039d8fec"
CHECKPOINT = "20261118T220646Z-bde7303509364deaacbf1ed94d5c793e"
EXPECTED_OLD_PID = 715459
BASE = Path("/opt/console-mcp-deploy")
POLICY = BASE / "broker-policy.json"
LOCK = BASE / "broker.lock"
ALLOWED_KEYS = frozenset(("schemaVersion", "authorizedSha", "sourcePath", "enabledOperations", "authorizationLease"))
LEASE_OWNER = "stage09-exact-sha-validate"
LEASE_SECONDS = 1800


def require_dir(path, uid=0):
    st = path.lstat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != uid or (st.st_mode & 0o022):
        raise RuntimeError("UNTRUSTED_DIRECTORY:" + str(path))


def open_root_chain(path, uid=0):
    """Anchor every absolute path component at /; reject symlinks and unsafe ancestors."""
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts:
        raise RuntimeError("UNTRUSTED_ABSOLUTE_PATH")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY |
                            os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            st = os.fstat(fd)
            if (not stat.S_ISDIR(st.st_mode) or st.st_uid != uid or
                    st.st_mode & 0o022):
                raise RuntimeError("UNTRUSTED_ANCESTOR_DIRECTORY")
        return fd
    except BaseException:
        os.close(fd)
        raise


def open_trusted(path, uid=0):
    """Resolve the final file beneath a trusted, opened parent directory."""
    parentfd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        parent = os.fstat(parentfd)
        if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != uid or
                parent.st_mode & 0o022):
            raise RuntimeError("UNTRUSTED_PARENT_DIRECTORY")
        fd = os.open(path.name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=parentfd)
        try:
            st = os.fstat(fd)
            if (not stat.S_ISREG(st.st_mode) or st.st_uid != uid or
                    st.st_mode & 0o077 or st.st_nlink != 1):
                raise RuntimeError("UNTRUSTED_POLICY_FILE")
            return fd
        except BaseException:
            os.close(fd)
            raise
    finally:
        os.close(parentfd)


def open_sealed_file(path, uid=0):
    """Read a sealed root-owned file without requiring policy-secret 0600 mode."""
    parentfd = open_root_chain(path.parent, uid=uid)
    try:
        directory = os.fstat(parentfd)
        if (not stat.S_ISDIR(directory.st_mode) or directory.st_uid != uid or
                directory.st_mode & 0o022):
            raise RuntimeError("UNTRUSTED_SEALED_PARENT")
        fd = os.open(path.name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=parentfd)
        st = os.fstat(fd)
        if (not stat.S_ISREG(st.st_mode) or st.st_uid != uid or
                st.st_mode & 0o022 or st.st_nlink != 1):
            os.close(fd)
            raise RuntimeError("UNTRUSTED_SEALED_FILE")
        return fd
    finally:
        os.close(parentfd)


def sealed_inventory(release, uid=0, pinned_rootfd=None):
    """Walk a sealed tree by pinned directory descriptors, never pathname traversal."""
    rootfd = os.dup(pinned_rootfd) if pinned_rootfd is not None else open_root_chain(release, uid=uid)
    inventory = {}
    try:
        def walk(dirfd, prefix, ancestors):
            st = os.fstat(dirfd)
            if (not stat.S_ISDIR(st.st_mode) or st.st_uid != uid or st.st_mode & 0o022):
                raise RuntimeError("UNTRUSTED_SEALED_DIRECTORY")
            for name in os.listdir(dirfd):
                if name in (".", "..") or "/" in name:
                    raise RuntimeError("SEALED_NAME_INVALID")
                rel = prefix + name
                if rel == "release.json":
                    continue
                entry = os.stat(name, dir_fd=dirfd, follow_symlinks=False)
                if entry.st_uid != uid or (not stat.S_ISLNK(entry.st_mode) and entry.st_mode & 0o022):
                    raise RuntimeError("UNTRUSTED_SEALED_RELEASE_MEMBER")
                if stat.S_ISDIR(entry.st_mode):
                    childfd = os.open(name, os.O_RDONLY | os.O_DIRECTORY |
                                      os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=dirfd)
                    try:
                        opened = os.fstat(childfd)
                        if (opened.st_dev, opened.st_ino) != (entry.st_dev, entry.st_ino):
                            raise RuntimeError("SEALED_DIRECTORY_INODE_DRIFT")
                        walk(childfd, rel + "/", ancestors + (name,))
                    finally:
                        os.close(childfd)
                elif stat.S_ISREG(entry.st_mode):
                    fd = os.open(name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=dirfd)
                    try:
                        opened = os.fstat(fd)
                        if ((opened.st_dev, opened.st_ino) != (entry.st_dev, entry.st_ino) or
                                opened.st_nlink != 1 or opened.st_uid != uid or opened.st_mode & 0o022):
                            raise RuntimeError("SEALED_FILE_INODE_DRIFT")
                        digest = hashlib.sha256()
                        while chunk := os.read(fd, 1048576):
                            digest.update(chunk)
                        inventory[rel] = digest.hexdigest()
                    finally:
                        os.close(fd)
                elif stat.S_ISLNK(entry.st_mode):
                    target = os.readlink(name, dir_fd=dirfd)
                    after = os.stat(name, dir_fd=dirfd, follow_symlinks=False)
                    if ((after.st_dev, after.st_ino) != (entry.st_dev, entry.st_ino) or
                            not target or len(target) > 4096 or target.startswith("/")):
                        raise RuntimeError("SEALED_LINK_INVALID")
                    parts = list(ancestors)
                    for component in target.split("/"):
                        if component in ("", "."):
                            continue
                        if component == "..":
                            if not parts:
                                raise RuntimeError("SEALED_LINK_ESCAPE")
                            parts.pop()
                        else:
                            parts.append(component)
                    if not parts or len(parts) > 128:
                        raise RuntimeError("SEALED_LINK_INVALID")
                    targetfd = os.dup(rootfd)
                    try:
                        for component in parts[:-1]:
                            nextfd = os.open(component, os.O_RDONLY | os.O_DIRECTORY |
                                             os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=targetfd)
                            os.close(targetfd)
                            targetfd = nextfd
                            st = os.fstat(targetfd)
                            if st.st_uid != uid or st.st_mode & 0o022:
                                raise RuntimeError("SEALED_LINK_UNTRUSTED_TARGET")
                        resolved = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW |
                                           os.O_CLOEXEC, dir_fd=targetfd)
                        try:
                            st = os.fstat(resolved)
                            if (not stat.S_ISREG(st.st_mode) or st.st_uid != uid or
                                    st.st_mode & 0o022 or st.st_nlink != 1):
                                raise RuntimeError("SEALED_LINK_UNTRUSTED_TARGET")
                        finally:
                            os.close(resolved)
                    finally:
                        os.close(targetfd)
                    final_link = os.stat(name, dir_fd=dirfd, follow_symlinks=False)
                    if ((final_link.st_dev, final_link.st_ino) != (entry.st_dev, entry.st_ino) or
                            os.readlink(name, dir_fd=dirfd) != target):
                        raise RuntimeError("SEALED_LINK_CHANGED_DURING_VALIDATION")
                    inventory[rel] = "link:" + target
                else:
                    raise RuntimeError("SEALED_RELEASE_SPECIAL_FILE")
        walk(rootfd, "", ())
        return inventory
    finally:
        os.close(rootfd)


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



def select_release_root(base, canonical=Path("/home/alex/smartresponse/mcp/.releases"), uid=0):
    """Mirror the reviewed release-store-selector policy without executing it."""
    policy = base / "release-store.json"
    try:
        fd = open_trusted(policy, uid=uid)
    except FileNotFoundError:
        return base / "releases"
    try:
        with os.fdopen(fd, "rb", closefd=False) as h:
            raw = h.read(65537)
        if len(raw) > 65536:
            raise RuntimeError("RELEASE_STORAGE_POLICY_TOO_LARGE")
        doc = json.loads(raw)
    finally:
        os.close(fd)
    if (not isinstance(doc, dict) or
            set(doc) != {"schemaVersion", "mode", "artifactRoot", "migrationAdmitted"} or
            doc["schemaVersion"] != 1 or type(doc["migrationAdmitted"]) is not bool):
        raise RuntimeError("RELEASE_STORAGE_POLICY_INVALID")
    if doc["mode"] == "legacy" and doc["artifactRoot"] == str(base / "releases"):
        return base / "releases"
    if (doc["mode"] != "canonical" or doc["artifactRoot"] != str(canonical) or
            not doc["migrationAdmitted"]):
        raise RuntimeError("RELEASE_STORAGE_UNRECOGNIZED_ROOT")
    # The canonical root must be root-owned with safe ancestors.
    current = canonical
    while True:
        require_dir(current, uid)
        if current.parent == current:
            break
        current = current.parent
    return canonical


def validate_sandbox_evidence(proof, role, release_sha, registry):
    if (not isinstance(proof, dict) or proof.get("passed") is not True or
            proof.get("sourceSHA") != SHA or proof.get(role) != release_sha or
            not isinstance(proof.get("buildFingerprint"), str) or
            not proof["buildFingerprint"] or
            not isinstance(proof.get("registryFingerprint"), str) or
            not proof["registryFingerprint"] or
            type(proof.get("pid")) is not int or proof["pid"] <= 0 or
            type(proof.get("at")) not in (int, float) or
            not math.isfinite(proof["at"]) or proof["at"] <= 0):
        raise RuntimeError("SANDBOX_EVIDENCE_BINDING_MISMATCH:" + role)
    if role == "rollback" and proof["registryFingerprint"] != registry.get("rollbackRegistryFingerprint"):
        raise RuntimeError("ROLLBACK_FINGERPRINT_MISMATCH")


def release_attestation():
    """Read-only exact protected deployment binding, hashes and running incumbent."""
    require_dir(BASE)
    registry = BASE / "registry.json"
    fd = open_sealed_file(registry)
    try:
        st = os.fstat(fd)
        if st.st_nlink != 1:
            raise RuntimeError("REGISTRY_UNTRUSTED")
        with os.fdopen(fd, "rb", closefd=False) as handle:
            raw = handle.read(65537)
            if len(raw) > 65536:
                raise RuntimeError("REGISTRY_TOO_LARGE")
            reg = json.loads(raw)
    finally:
        os.close(fd)
    if (not isinstance(reg, dict) or reg.get("schemaVersion") != 2 or
        reg.get("candidate") != SHA or reg.get("sourceSHA") != SHA or
        reg.get("rollback") != ROLLBACK or reg.get("checkpoint") != CHECKPOINT or
        reg.get("oldPid") != EXPECTED_OLD_PID):
        raise RuntimeError("DEPLOYMENT_BINDING_MISMATCH")
    cp = BASE / "checkpoints" / CHECKPOINT
    require_dir(cp)
    operator_hashes = reg.get("operatorHashes")
    if not isinstance(operator_hashes, dict):
        raise RuntimeError("OPERATOR_HASH_BINDING_MISSING")
    for name in ("deploy.py", "release-store-selector.py"):
        digest = operator_hashes.get(name)
        if not isinstance(digest, str) or not re.fullmatch("[0-9a-f]{64}", digest):
            raise RuntimeError("OPERATOR_HASH_BINDING_MISSING")
        fd = open_sealed_file(BASE / name)
        try:
            with os.fdopen(fd, "rb", closefd=False) as h:
                content = h.read(1048577)
            if len(content) > 1048576 or hashlib.sha256(content).hexdigest() != digest:
                raise RuntimeError("OPERATOR_DIGEST_MISMATCH:" + name)
        finally:
            os.close(fd)
    for name, role, release_sha in (
            ("sandbox-result.json", "candidate", SHA),
            ("rollback-sandbox-result.json", "rollback", ROLLBACK)):
        fd = open_trusted(BASE / name)
        try:
            with os.fdopen(fd, "rb", closefd=False) as h:
                content = h.read(65537)
            if len(content) > 65536:
                raise RuntimeError("SANDBOX_EVIDENCE_TOO_LARGE")
            proof = json.loads(content)
            validate_sandbox_evidence(proof, role, release_sha, reg)
        finally:
            os.close(fd)
    # Independently inspect sealed release inventories; never execute deploy.py.
    candidates = {}
    release_root = select_release_root(BASE)
    for role, release_sha in (("candidate", SHA), ("rollback", ROLLBACK)):
        release = release_root / release_sha
        rootfd = open_root_chain(release)
        try:
            manifest_fd = os.open("release.json", os.O_RDONLY | os.O_CLOEXEC |
                                  os.O_NOFOLLOW, dir_fd=rootfd)
            try:
                manifest_st = os.fstat(manifest_fd)
                if (not stat.S_ISREG(manifest_st.st_mode) or manifest_st.st_uid != 0 or
                        manifest_st.st_mode & 0o022 or manifest_st.st_nlink != 1):
                    raise RuntimeError("SEALED_MANIFEST_UNTRUSTED")
                with os.fdopen(manifest_fd, "rb", closefd=False) as h:
                    manifest_bytes = h.read(1048577)
            finally:
                os.close(manifest_fd)
            if len(manifest_bytes) > 1048576:
                raise RuntimeError("SEALED_MANIFEST_TOO_LARGE")
            manifest = json.loads(manifest_bytes)
            expected = manifest.get("files") if isinstance(manifest, dict) else None
            if (not isinstance(manifest, dict) or manifest.get("sourceCommit") != release_sha or
                    not isinstance(expected, dict) or not expected):
                raise RuntimeError("SEALED_RELEASE_MISMATCH")
            actual = sealed_inventory(release, pinned_rootfd=rootfd)
            if expected != actual:
                raise RuntimeError("SEALED_RELEASE_INVENTORY_MISMATCH")
            candidates[role] = {"sha": release_sha, "files": len(actual)}
        finally:
            os.close(rootfd)

    status = subprocess.run(["/usr/bin/systemctl", "show", "console-mcp.service",
            "-p", "MainPID", "-p", "ActiveState", "-p", "BindReadOnlyPaths"],
            capture_output=True, text=True, timeout=12, check=True)
    values = dict(line.split("=",1) for line in status.stdout.splitlines() if "=" in line)
    if values.get("MainPID") != str(EXPECTED_OLD_PID) or values.get("ActiveState") != "active":
        raise RuntimeError("INCUMBENT_RUNTIME_DRIFT")
    live_dist = "/home/alex/smartresponse/mcp/console-mcp/dist"
    bound = [entry.split(":")[0] for entry in values.get("BindReadOnlyPaths","").split()
             if len(entry.split(":")) > 1 and entry.split(":")[1] == live_dist]
    if len(bound) != 1 or Path(bound[0]).parent.name != ROLLBACK:
        raise RuntimeError("INCUMBENT_MOUNT_DRIFT")
    return {"candidate": candidates["candidate"], "rollback": candidates["rollback"],
            "checkpoint": CHECKPOINT, "oldPid": EXPECTED_OLD_PID}


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
        "enabledOperations": ["validate"],
        "authorizationLease": {"owner": LEASE_OWNER, "expiresAt": now + LEASE_SECONDS},
    }


def authorize(policy, lock, expected, *, uid=0, now=None, verify_binding=None):
    if not re.fullmatch("[0-9a-f]{64}", expected):
        raise RuntimeError("EXPECTED_GENERATION_INVALID")
    if policy.parent != lock.parent:
        raise RuntimeError("POLICY_LOCK_PARENT_MISMATCH")
    now = time.time() if now is None else now
    dirfd = os.open(policy.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        parent = os.fstat(dirfd)
        if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != uid or parent.st_mode & 0o022:
            raise RuntimeError("UNTRUSTED_PARENT_DIRECTORY")
        lockfd = os.open(lock.name, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW,
                         0o600, dir_fd=dirfd)
        try:
            lockst = os.fstat(lockfd)
            if (not stat.S_ISREG(lockst.st_mode) or lockst.st_uid != uid or
                    lockst.st_mode & 0o077 or lockst.st_nlink != 1):
                raise RuntimeError("LOCK_PATH_UNTRUSTED")
            fcntl.flock(lockfd, fcntl.LOCK_EX)
            named = os.stat(lock.name, dir_fd=dirfd, follow_symlinks=False)
            if (lockst.st_dev, lockst.st_ino) != (named.st_dev, named.st_ino):
                raise RuntimeError("LOCK_PATH_CHANGED")
            policyfd = os.open(policy.name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=dirfd)
            try:
                st = os.fstat(policyfd)
                if (not stat.S_ISREG(st.st_mode) or st.st_uid != uid or
                        st.st_mode & 0o077 or st.st_nlink != 1):
                    raise RuntimeError("UNTRUSTED_POLICY_FILE")
                with os.fdopen(policyfd, "rb", closefd=False) as h:
                    raw = h.read(65537)
            finally:
                os.close(policyfd)
            if len(raw) > 65536 or hashlib.sha256(raw).hexdigest() != expected:
                raise RuntimeError("POLICY_GENERATION_CONFLICT")
            current = json.loads(raw)
            if (not isinstance(current, dict) or current.get("schemaVersion") != 1 or
                    set(current) - ALLOWED_KEYS):
                raise RuntimeError("POLICY_SCHEMA_INVALID")
            if verify_binding is not None:
                verify_binding()
            updated = proposed(current, now)
            encoded = (json.dumps(updated, sort_keys=True, indent=2) + "\n").encode()
            stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(now))
            backup_name = "broker-policy.stage09." + stamp + "." + expected[:12] + ".bak"
            bfd = os.open(backup_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                          os.O_CLOEXEC | os.O_NOFOLLOW, 0o600, dir_fd=dirfd)
            try:
                with os.fdopen(bfd, "wb") as b:
                    b.write(raw)
                    b.flush()
                    os.fsync(b.fileno())
            except BaseException:
                os.unlink(backup_name, dir_fd=dirfd)
                raise
            temp_name = ".stage09-policy-" + os.urandom(16).hex()
            tempfd = os.open(temp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                             os.O_CLOEXEC | os.O_NOFOLLOW, 0o600, dir_fd=dirfd)
            try:
                with os.fdopen(tempfd, "wb") as t:
                    t.write(encoded)
                    t.flush()
                    os.fsync(t.fileno())
                # Verify exact original inode and content before atomic replacement.
                currentfd = os.open(policy.name, os.O_RDONLY | os.O_CLOEXEC |
                                    os.O_NOFOLLOW, dir_fd=dirfd)
                try:
                    currentst = os.fstat(currentfd)
                    with os.fdopen(currentfd, "rb", closefd=False) as h:
                        current_raw = h.read(65537)
                    if ((st.st_dev, st.st_ino) != (currentst.st_dev, currentst.st_ino) or
                            currentst.st_nlink != 1 or current_raw != raw):
                        raise RuntimeError("POLICY_GENERATION_CONFLICT")
                finally:
                    os.close(currentfd)
                os.replace(temp_name, policy.name, src_dir_fd=dirfd, dst_dir_fd=dirfd)
                os.fsync(dirfd)
            finally:
                try:
                    os.unlink(temp_name, dir_fd=dirfd)
                except FileNotFoundError:
                    pass
            return {"status": "VALIDATE_ONLY_AUTHORIZED",
                    "generation": hashlib.sha256(encoded).hexdigest(),
                    "backup": str(policy.parent / backup_name),
                    "expiresAt": updated["authorizationLease"]["expiresAt"]}
        finally:
            os.close(lockfd)
    finally:
        os.close(dirfd)


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
    binding = release_attestation()
    raw, current, generation = inspect_policy()
    if args.inspect:
        print(json.dumps({"status": "READ_ONLY", "source": attestation, "binding": binding,
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
    receipt = authorize(POLICY, LOCK, args.expected_generation,
                        verify_binding=lambda: (source_attestation(), release_attestation()))
    print(json.dumps(receipt, sort_keys=True))


if __name__ == "__main__":
    main()
