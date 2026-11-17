#!/usr/bin/python3
"""Root-only explicit policy provisioning and lease renewal. Never called by the unprivileged broker."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

MODULE = Path(__file__).with_name("release-policy-cas.py")
spec = importlib.util.spec_from_file_location("release_policy_cas", MODULE)
cas = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cas)


def provision(path: Path, lock: Path, expected: str, owner: str, seconds: int,
              desired: dict) -> dict:
    if os.geteuid() != 0:
        raise PermissionError("RELEASE_POLICY_ROOT_REQUIRED")
    if not path.is_absolute() or not lock.is_absolute() or path == lock:
        raise ValueError("RELEASE_POLICY_PATH_INVALID")
    return cas.replace_if_generation(path, lock, expected, owner, seconds, desired)


def renew(path: Path, lock: Path, expected: str, owner: str, seconds: int) -> dict:
    if os.geteuid() != 0:
        raise PermissionError("RELEASE_POLICY_ROOT_REQUIRED")
    snapshot = cas.inspect(path)
    if snapshot["generation"] != expected:
        raise cas.PolicyConflict("RELEASE_POLICY_GENERATION_CONFLICT")
    current = snapshot["policy"]
    lease = current.get("authorizationLease")
    if not isinstance(lease, dict) or lease.get("owner") != owner:
        raise cas.PolicyConflict("RELEASE_POLICY_LEASE_OWNER_MISMATCH")
    return cas.replace_if_generation(path, lock, expected, owner, seconds, current)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("inspect", "provision", "renew"))
    parser.add_argument("--policy", required=True, type=Path)
    parser.add_argument("--lock", type=Path)
    parser.add_argument("--expected-generation")
    parser.add_argument("--owner")
    parser.add_argument("--lease-seconds", type=int, default=300)
    parser.add_argument("--desired-policy", type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise PermissionError("RELEASE_POLICY_ROOT_REQUIRED")
    if args.operation == "inspect":
        result = cas.inspect(args.policy)
        print(json.dumps({"generation": result["generation"]}))
        return 0
    if (not args.lock or not args.expected_generation or not args.owner
            or not re.fullmatch(r"[0-9a-f]{64}", args.expected_generation)):
        parser.error("lock, owner and expected generation are required")
    if args.operation == "renew":
        result = renew(args.policy, args.lock, args.expected_generation,
                       args.owner, args.lease_seconds)
    else:
        if not args.desired_policy:
            parser.error("desired policy file required")
        desired = json.loads(args.desired_policy.read_text())
        result = provision(args.policy, args.lock, args.expected_generation,
                           args.owner, args.lease_seconds, desired)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError) as exc:
        print(type(exc).__name__ + ": " + str(exc), file=sys.stderr)
        sys.exit(1)
