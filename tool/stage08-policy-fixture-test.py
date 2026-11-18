#!/usr/bin/python3
"""Unprivileged fixture verification only; NEVER points at production policy."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile

src = Path(__file__).resolve().parents[1] / "ops/ubuntu/deployment/stage08-authorize-prepare.py"
spec = importlib.util.spec_from_file_location("stage08_policy", src)
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
    evidence = mod.authorize(policy, lock, generation, uid=os.getuid(), now=1800000000)
    updated = json.loads(policy.read_text())
    assert evidence["status"] == "PREPARE_ONLY_AUTHORIZED"
    assert updated["authorizedSha"] == mod.SHA
    assert updated["sourcePath"] == str(mod.SOURCE)
    assert updated["enabledOperations"] == ["prepare"]
    assert updated["authorizationLease"]["owner"] == mod.LEASE_OWNER
    assert evidence["expiresAt"] == 1800000900
    assert Path(evidence["backup"]).read_bytes() == (json.dumps(original, sort_keys=True) + "\n").encode()
    assert (Path(evidence["backup"]).stat().st_mode & 0o777) == 0o600
    assert (policy.stat().st_mode & 0o777) == 0o600
    try:
        mod.authorize(policy, lock, generation, uid=os.getuid(), now=1800000001)
        raise AssertionError("stale CAS unexpectedly authorized")
    except RuntimeError as exc:
        assert "POLICY_GENERATION_CONFLICT" in str(exc)
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

print(json.dumps({"status": "STAGE08_UNPRIVILEGED_POLICY_FIXTURE_PASS",
                  "checks": ["atomic-locked-CAS", "original-byte-backup",
                             "backup-mode-0600", "prepare-only", "fixed-sha-source",
                             "lease", "stale-generation-denial", "foreign-lease-denial",
                             "symlink-denial", "unknown-key-denial"]}))
