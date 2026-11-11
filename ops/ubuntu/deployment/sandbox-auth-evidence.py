#!/usr/bin/python3
"""Pure, fail-closed validation of root-owned authenticated sandbox receipts."""
import math

def verify(proof, *, role, release_sha, release_id, registry_fingerprint, expected_build, now, max_age=600):
    if not isinstance(proof, dict):
        raise RuntimeError("SANDBOX_AUTH_EVIDENCE_MISSING")
    if role not in ("candidate", "rollback"):
        raise RuntimeError("SANDBOX_AUTH_ROLE_INVALID")
    if proof.get("passed") is not True or proof.get("authenticatedMcpSmoke") is not True:
        raise RuntimeError("SANDBOX_AUTH_EVIDENCE_FAILED")
    if proof.get("sourceSHA") != release_sha or proof.get(role) != release_id:
        raise RuntimeError("SANDBOX_AUTH_IDENTITY_MISMATCH")
    if proof.get("registryFingerprint") != registry_fingerprint:
        raise RuntimeError("SANDBOX_AUTH_REGISTRY_DRIFT")
    if type(proof.get("advertisedToolCount")) is not int or proof["advertisedToolCount"] < 3:
        raise RuntimeError("SANDBOX_AUTH_CATALOG_INVALID")
    if type(proof.get("pid")) is not int or proof["pid"] <= 0:
        raise RuntimeError("SANDBOX_AUTH_PID_INVALID")
    if not isinstance(expected_build, str) or not expected_build or proof.get("buildFingerprint") != expected_build:
        raise RuntimeError("SANDBOX_AUTH_BUILD_MISSING")
    at=proof.get("at")
    if type(at) not in (float, int) or not math.isfinite(at) or now < at or now-at >= max_age:
        raise RuntimeError("SANDBOX_AUTH_EVIDENCE_STALE")
    return True
