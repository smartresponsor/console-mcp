#!/usr/bin/env python3
"""Read-only local Git evidence collector; never authorizes a production release.

A root-owned reconciler must separately verify remote identity, protected-branch
policy and GitHub checks using authenticated sources. This module does not do so.
"""
import pathlib
import re
import subprocess

SHA = re.compile(r"^[0-9a-f]{40}$")
REF = "refs/heads/master"


def collect(git_dir, expected_sha, *, run=None):
    """Inspect an already-fetched isolated Git store, without fetching or mutating it."""
    def blocked(code):
        return {"status": "BLOCKED", "reasonCode": code, "action": "NO_MUTATION"}

    if not isinstance(expected_sha, str) or not SHA.fullmatch(expected_sha):
        return blocked("INVALID_EXPECTED_SHA")
    path = pathlib.Path(git_dir)
    if not path.is_absolute() or not path.is_dir() or path.is_symlink():
        return blocked("INVALID_GIT_STORE")
    runner = run or subprocess.run

    def git(*args):
        result = runner(
            ["git", "--git-dir", str(path), *args],
            capture_output=True, text=True, timeout=15, check=False,
        )
        if result.returncode:
            raise ValueError("git command failed")
        return result.stdout.strip()

    try:
        # Avoid abbreviated, ambiguous, or caller-selected refs.
        actual = git("rev-parse", "--verify", REF + "^{commit}")
        if not SHA.fullmatch(actual) or actual != expected_sha:
            return blocked("REF_SHA_MISMATCH")
        # git verify-commit validates cryptographic signature but does NOT
        # establish trusted signer identity or protected branch admission.
        git("verify-commit", expected_sha)
        commit_type = git("cat-file", "-t", expected_sha)
        if commit_type != "commit":
            return blocked("NOT_A_COMMIT")
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return blocked("LOCAL_GIT_VERIFICATION_FAILED")

    return {
        "status": "LOCAL_SIGNATURE_VERIFIED",
        "sha": expected_sha,
        "ref": REF,
        "signatureVerifiedLocally": True,
        "protectedBranchVerified": False,
        "sourceVerified": False,
        "checksVerified": False,
        "eligible": False,
        "action": "NO_MUTATION",
    }
