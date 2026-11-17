#!/usr/bin/python3
"""Offline, fixed-scope root-only acceptance for PR #294; not an MCP entrypoint."""
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path("/opt/pr294-offline-test/source")
EXPECTED = Path("/opt/pr294-offline-test/expected-sha")
TESTS = (
    "ops/ubuntu/deployment/release-policy-cas-regression.py",
    "ops/ubuntu/deployment/release-policy-snapshot-regression.py",
)

def main():
    if os.geteuid() != 0:
        raise SystemExit("ROOT_REQUIRED")
    if ROOT.is_symlink() or not ROOT.is_dir() or ROOT.stat().st_uid != 0:
        raise SystemExit("UNTRUSTED_SOURCE")
    if EXPECTED.is_symlink() or EXPECTED.stat().st_uid != 0 or EXPECTED.stat().st_mode & 0o022:
        raise SystemExit("UNTRUSTED_EXPECTED_SHA")
    expected = EXPECTED.read_text(encoding="ascii").strip()
    if len(expected) != 40 or any(c not in "0123456789abcdef" for c in expected):
        raise SystemExit("INVALID_EXPECTED_SHA")
    actual = subprocess.check_output(["/usr/bin/git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True).strip()
    if actual != expected:
        raise SystemExit("SHA_MISMATCH")
    dirty = subprocess.check_output(["/usr/bin/git", "-C", str(ROOT), "status", "--porcelain"], text=True)
    if dirty:
        raise SystemExit("DIRTY_CHECKOUT")
    for relative in TESTS:
        target = ROOT / relative
        if target.is_symlink() or not target.is_file() or target.stat().st_uid != 0:
            raise SystemExit("UNTRUSTED_TEST_FILE")
        completed = subprocess.run(["/usr/bin/python3", "-B", str(target), "-v"],
                                   cwd=ROOT, env={"PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"},
                                   check=False)
        if completed.returncode:
            raise SystemExit(f"TEST_FAILED:{relative}:{completed.returncode}")
    print(f"PR294_OFFLINE_ROOT_TESTS_PASS SHA={actual}", flush=True)

if __name__ == "__main__":
    main()
