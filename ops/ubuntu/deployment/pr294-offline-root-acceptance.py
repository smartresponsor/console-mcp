#!/usr/bin/python3
"""Offline, fixed-scope root-only acceptance for PR #294; not an MCP entrypoint."""
import os
from pathlib import Path
import subprocess
import stat

ROOT = Path("/opt/pr294-offline-test/source")
EXPECTED = Path("/opt/pr294-offline-test/expected-sha")
TESTS = (
    "ops/ubuntu/deployment/release-policy-cas-regression.py",
    "ops/ubuntu/deployment/release-policy-snapshot-regression.py",
)

def trusted_path(path, directory=False):
    for component in (path, *path.parents):
        metadata = component.lstat()
        if stat.S_ISLNK(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022:
            raise SystemExit(f"UNTRUSTED_PATH:{component}")
    metadata = path.stat()
    if directory and not stat.S_ISDIR(metadata.st_mode):
        raise SystemExit(f"NOT_DIRECTORY:{path}")
    if not directory and not stat.S_ISREG(metadata.st_mode):
        raise SystemExit(f"NOT_REGULAR_FILE:{path}")


def main():
    if os.geteuid() != 0:
        raise SystemExit("ROOT_REQUIRED")
    trusted_path(ROOT, directory=True)
    trusted_path(EXPECTED)
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
        trusted_path(target)
        completed = subprocess.run(["/usr/bin/python3", "-B", str(target), "-v"],
                                   cwd=ROOT, env={"PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"},
                                   check=False)
        if completed.returncode:
            raise SystemExit(f"TEST_FAILED:{relative}:{completed.returncode}")
    print(f"PR294_OFFLINE_ROOT_TESTS_PASS SHA={actual}", flush=True)

if __name__ == "__main__":
    main()
