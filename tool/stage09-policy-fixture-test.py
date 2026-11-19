#!/usr/bin/python3
"""Unprivileged fixture verification only; NEVER points at production policy."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile

src = Path(__file__).resolve().parents[1] / "ops/ubuntu/deployment/stage09-authorize-validate.py"
spec = importlib.util.spec_from_file_location("stage09_policy", src)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def policy_data(path, value):
    raw = (json.dumps(value, sort_keys=True) + "\n").encode()
    path.write_bytes(raw)
    path.chmod(0o600)
    return hashlib.sha256(raw).hexdigest()


with tempfile.TemporaryDirectory(prefix="stage08-policy-fixture-") as tmp:
    root = Path(tmp)
    root.chmod(0o700)
    policy = root / "broker-policy.json"
    lock = root / "broker.lock"
    original = {"schemaVersion": 1,
                "authorizedSha": "a" * 40,
                "sourcePath": "/older/release",
                "enabledOperations": ["prepare", "validate", "activate", "rollback"]}
    generation = policy_data(policy, original)
    verifier_calls = []
    evidence = mod.authorize(policy, lock, generation, uid=os.getuid(), now=1800000000,
                             verify_binding=lambda: verifier_calls.append(True))
    assert verifier_calls == [True]
    updated = json.loads(policy.read_text())
    assert evidence["status"] == "VALIDATE_ONLY_AUTHORIZED"
    assert updated["authorizedSha"] == mod.SHA
    assert updated["sourcePath"] == str(mod.SOURCE)
    assert updated["enabledOperations"] == ["validate"]
    assert updated["authorizationLease"]["owner"] == mod.LEASE_OWNER
    assert evidence["expiresAt"] == 1800001800
    assert Path(evidence["backup"]).read_bytes() == (json.dumps(original, sort_keys=True) + "\n").encode()
    assert (Path(evidence["backup"]).stat().st_mode & 0o777) == 0o600
    assert (policy.stat().st_mode & 0o777) == 0o600
    try:
        mod.authorize(policy, lock, generation, uid=os.getuid(), now=1800000001)
        raise AssertionError("stale CAS unexpectedly authorized")
    except RuntimeError as exc:
        assert "POLICY_GENERATION_CONFLICT" in str(exc)
    # Binding check must fail before backup and mutation within the CAS lock.
    normal = policy_data(policy, {"schemaVersion": 1, "authorizedSha": "d" * 40})
    before_backups = set(root.glob("*.bak"))
    def reject_binding():
        raise RuntimeError("DEPLOYMENT_BINDING_MISMATCH")
    try:
        mod.authorize(policy, lock, normal, uid=os.getuid(), now=1800000001,
                      verify_binding=reject_binding)
        raise AssertionError("invalid deployment binding authorized")
    except RuntimeError as exc:
        assert "DEPLOYMENT_BINDING_MISMATCH" in str(exc)
    assert set(root.glob("*.bak")) == before_backups
    assert json.loads(policy.read_text())["authorizedSha"] == "d" * 40
    other = {"schemaVersion": 1, "authorizedSha": "c" * 40,
             "authorizationLease": {"owner": "someone-else", "expiresAt": 1800000300}}
    other_gen = policy_data(policy, other)
    try:
        mod.authorize(policy, lock, other_gen, uid=os.getuid(), now=1800000002)
        raise AssertionError("foreign lease unexpectedly authorized")
    except RuntimeError as exc:
        assert "ACTIVE_FOREIGN_LEASE" in str(exc)
    invalid_lease = {"schemaVersion": 1, "authorizedSha": "c" * 40,
                     "authorizationLease": {"owner": "other", "expiresAt": float("nan")}}
    invalid_gen = policy_data(policy, invalid_lease)
    try:
        mod.authorize(policy, lock, invalid_gen, uid=os.getuid(), now=1800000002)
        raise AssertionError("NaN lease unexpectedly authorized")
    except RuntimeError as exc:
        assert "OLD_LEASE_INVALID" in str(exc)
    policy.unlink()
    policy.symlink_to(root / "nonexistent")
    try:
        mod.authorize(policy, lock, "a" * 64, uid=os.getuid(), now=1800000002)
        raise AssertionError("symlink policy unexpectedly authorized")
    except (OSError, RuntimeError):
        pass
    policy.unlink()
    gen = policy_data(policy, {"schemaVersion": 1, "extraPrivilege": "unknown"})
    try:
        mod.authorize(policy, lock, gen, uid=os.getuid(), now=1800000002)
        raise AssertionError("unknown policy schema unexpectedly authorized")
    except RuntimeError as exc:
        assert "POLICY_SCHEMA_INVALID" in str(exc)

# Concurrent adversary: replace the policy inode while authorization holds its lock.
with tempfile.TemporaryDirectory(prefix="stage09-race-") as tmp:
    import threading
    root = Path(tmp)
    root.chmod(0o700)
    policy = root / "broker-policy.json"
    lock = root / "broker.lock"
    original = {"schemaVersion": 1, "authorizedSha": "a" * 40}
    generation = policy_data(policy, original)
    before = policy.read_bytes()
    start = threading.Event()
    finished = threading.Event()
    def swap_inode():
        assert start.wait(5)
        replacement = root / "replacement.json"
        replacement.write_bytes(before)
        replacement.chmod(0o600)
        os.replace(replacement, policy)
        finished.set()
    adversary = threading.Thread(target=swap_inode, daemon=True)
    adversary.start()
    def concurrent_swap():
        start.set()
        assert finished.wait(5)
    try:
        mod.authorize(policy, lock, generation, uid=os.getuid(),
                      now=1800000000, verify_binding=concurrent_swap)
        raise AssertionError("concurrent policy inode swap accepted")
    except RuntimeError as exc:
        assert "POLICY_GENERATION_CONFLICT" in str(exc)
    adversary.join(timeout=5)
    assert not adversary.is_alive()
    assert policy.read_bytes() == before
    assert not list(root.glob(".stage09-policy-*"))

# Deterministic adversarial swap while the policy lock is held.
with tempfile.TemporaryDirectory(prefix="stage09-cas-swap-") as tmp:
    root = Path(tmp)
    root.chmod(0o700)
    policy = root / "broker-policy.json"
    lock = root / "broker.lock"
    original = {"schemaVersion": 1, "authorizedSha": "a" * 40}
    generation = policy_data(policy, original)
    replacement = root / "replacement.json"
    policy_data(replacement, original)
    def swap_inode():
        os.replace(replacement, policy)
    try:
        mod.authorize(policy, lock, generation, uid=os.getuid(),
                      now=1800000000, verify_binding=swap_inode)
        raise AssertionError("same-content inode swap accepted")
    except RuntimeError as exc:
        assert "POLICY_GENERATION_CONFLICT" in str(exc)
    assert json.loads(policy.read_text()) == original

# Adversarial inode and directory boundary tests: never touch production.
with tempfile.TemporaryDirectory(prefix="stage09-adversarial-") as tmp:
    root = Path(tmp)
    root.chmod(0o700)
    target = root / "trusted.json"
    target.write_text("{}")
    target.chmod(0o600)
    fd = mod.open_trusted(target, uid=os.getuid())
    os.close(fd)
    alias = root / "alias.json"
    os.link(target, alias)
    try:
        mod.open_trusted(target, uid=os.getuid())
        raise AssertionError("hardlinked trusted file accepted")
    except RuntimeError as exc:
        assert "UNTRUSTED_POLICY_FILE" in str(exc)
    alias.unlink()
    target.unlink()
    target.symlink_to(root / "missing")
    try:
        mod.open_trusted(target, uid=os.getuid())
        raise AssertionError("symlink accepted")
    except (OSError, RuntimeError):
        pass
    target.unlink()
    target.write_text("{}")
    target.chmod(0o600)
    root.chmod(0o777)
    try:
        mod.open_trusted(target, uid=os.getuid())
        raise AssertionError("world-writable parent accepted")
    except RuntimeError as exc:
        assert "UNTRUSTED_PARENT_DIRECTORY" in str(exc)

# Deployment evidence must be structurally and cryptographically bound to the registry.
with tempfile.TemporaryDirectory(prefix="stage09-evidence-") as tmp:
    root = Path(tmp)
    root.chmod(0o700)
    reg = {"rollbackRegistryFingerprint": "r" * 64}
    candidate = {"passed": True, "sourceSHA": mod.SHA, "candidate": mod.SHA,
                 "buildFingerprint": "b" * 64, "registryFingerprint": "c" * 64,
                 "pid": 123, "at": 1800000000}
    rollback = dict(candidate, rollback=mod.ROLLBACK, registryFingerprint="r" * 64)
    mod.validate_sandbox_evidence(candidate, "candidate", mod.SHA, reg)
    mod.validate_sandbox_evidence(rollback, "rollback", mod.ROLLBACK, reg)
    for key, bad in [("passed", False), ("sourceSHA", "f" * 40),
                     ("candidate", "e" * 40), ("pid", True),
                     ("at", float("nan")), ("buildFingerprint", "")]:
        changed = dict(candidate, **{key: bad})
        try:
            mod.validate_sandbox_evidence(changed, "candidate", mod.SHA, reg)
            raise AssertionError("invalid evidence accepted: " + key)
        except RuntimeError as exc:
            assert "SANDBOX_EVIDENCE_BINDING_MISMATCH" in str(exc)
    changed = dict(rollback, registryFingerprint="wrong")
    try:
        mod.validate_sandbox_evidence(changed, "rollback", mod.ROLLBACK, reg)
        raise AssertionError("rollback fingerprint drift accepted")
    except RuntimeError as exc:
        assert "ROLLBACK_FINGERPRINT_MISMATCH" in str(exc)
    assert mod.select_release_root(root, uid=os.getuid()) == root / "releases"
    policy = root / "release-store.json"
    def store_policy(mode, artifact, admitted):
        policy_data(policy, {"schemaVersion": 1, "mode": mode,
                             "artifactRoot": artifact, "migrationAdmitted": admitted})
    store_policy("legacy", str(root / "releases"), False)
    assert mod.select_release_root(root, uid=os.getuid()) == root / "releases"
    store_policy("canonical", str(root / "canonical"), False)
    try:
        mod.select_release_root(root, canonical=root / "canonical", uid=os.getuid())
        raise AssertionError("unadmitted canonical migration accepted")
    except RuntimeError as exc:
        assert "RELEASE_STORAGE_UNRECOGNIZED_ROOT" in str(exc)
    store_policy("canonical", str(root / "canonical"), True)
    canonical = root / "canonical"
    canonical.mkdir(mode=0o700)
    from unittest.mock import patch
    with patch.object(mod, "require_dir", return_value=None):
        assert mod.select_release_root(root, canonical=canonical, uid=os.getuid()) == canonical

# Full ancestor-chain traversal must reject unsafe /tmp and intermediate symlinks.
with tempfile.TemporaryDirectory(prefix="stage09-ancestor-") as tmp:
    try:
        fd = mod.open_root_chain(Path(tmp), uid=os.getuid())
        os.close(fd)
        raise AssertionError("unsafe ancestor chain accepted")
    except RuntimeError as exc:
        assert "UNTRUSTED_ANCESTOR_DIRECTORY" in str(exc)
    alias = Path(tmp) / "alias"
    alias.symlink_to(Path(tmp))
    try:
        fd = mod.open_root_chain(alias, uid=os.getuid())
        os.close(fd)
        raise AssertionError("ancestor symlink accepted")
    except (RuntimeError, OSError):
        pass

# Descriptor-pinned sealed inventory, malicious link and hardlink denial.
with tempfile.TemporaryDirectory(prefix="stage09-sealed-") as tmp:
    root = Path(tmp)
    root.chmod(0o700)
    sub = root / "dist"
    sub.mkdir(mode=0o700)
    member = sub / "index.js"
    member.write_bytes(b"const ok = true;")
    member.chmod(0o600)
    from unittest.mock import patch
    def fixture_inventory():
        # /tmp is intentionally sticky/world-writable; test sealed descendants only.
        with patch.object(mod, "open_root_chain", side_effect=lambda path, uid=0: os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)):
            return mod.sealed_inventory(root, uid=os.getuid())
    assert fixture_inventory() == {
        "dist/index.js": hashlib.sha256(b"const ok = true;").hexdigest()
    }
    with patch.object(mod, "open_root_chain", side_effect=AssertionError("must reuse pinned fd")):
        pinned = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            assert mod.sealed_inventory(root, uid=os.getuid(), pinned_rootfd=pinned) == {
                "dist/index.js": hashlib.sha256(b"const ok = true;").hexdigest()
            }
        finally:
            os.close(pinned)
    alias = sub / "hardlink.js"
    os.link(member, alias)
    try:
        fixture_inventory()
        raise AssertionError("hardlink in sealed inventory accepted")
    except RuntimeError as exc:
        assert "SEALED_FILE_INODE_DRIFT" in str(exc)
    alias.unlink()
    bin_dir = root / "node_modules" / ".bin"
    bin_dir.mkdir(parents=True, mode=0o700)
    which_dir = root / "node_modules" / "which" / "bin"
    which_dir.mkdir(parents=True, mode=0o700)
    for safe_dir in (root / "node_modules", bin_dir, root / "node_modules" / "which", which_dir):
        safe_dir.chmod(0o700)
    executable = which_dir / "node-which"
    executable.write_bytes(b"#!/bin/sh\n")
    executable.chmod(0o700)
    good_link = bin_dir / "node-which"
    good_link.symlink_to("../which/bin/node-which")
    assert fixture_inventory()["node_modules/.bin/node-which"] == "link:../which/bin/node-which"
    real_readlink = os.readlink
    link_calls = [0]
    def swap_link_target(name, *args, **kwargs):
        if name == "node-which":
            link_calls[0] += 1
            if link_calls[0] == 2:
                return "../which/bin/altered"
        return real_readlink(name, *args, **kwargs)
    with patch.object(mod.os, "readlink", side_effect=swap_link_target):
        try:
            fixture_inventory()
            raise AssertionError("symlink target drift accepted")
        except RuntimeError as exc:
            assert "SEALED_LINK_CHANGED_DURING_VALIDATION" in str(exc)
    good_link.unlink()
    for bad_target in ("../../../../etc/passwd", "/etc/passwd", "../missing", "../which/bin/../../../../etc/passwd"):
        bad_link = bin_dir / "node-which"
        bad_link.symlink_to(bad_target)
        try:
            fixture_inventory()
            raise AssertionError("malicious link accepted: " + bad_target)
        except (RuntimeError, OSError) as exc:
            assert "malicious link accepted" not in str(exc)
        finally:
            bad_link.unlink()
    escape = sub / "escape"
    escape.symlink_to("/etc/passwd")
    try:
        fixture_inventory()
        raise AssertionError("sealed symlink accepted")
    except RuntimeError as exc:
        assert "SEALED_LINK_INVALID" in str(exc) or "UNTRUSTED_SEALED_RELEASE_MEMBER" in str(exc)
    escape.unlink()
    sub.chmod(0o777)
    try:
        fixture_inventory()
        raise AssertionError("world-writable sealed directory accepted")
    except RuntimeError as exc:
        assert "UNTRUSTED_SEALED_RELEASE_MEMBER" in str(exc)

print(json.dumps({"status": "STAGE09_UNPRIVILEGED_POLICY_FIXTURE_PASS",
                  "checks": ["atomic-locked-CAS", "original-byte-backup",
                             "backup-mode-0600", "prepare-only", "fixed-sha-source",
                             "lease", "stale-generation-denial", "foreign-lease-denial",
                             "symlink-denial", "unknown-key-denial", "binding-denial-before-CAS", "nonfinite-lease-denial"]}))
