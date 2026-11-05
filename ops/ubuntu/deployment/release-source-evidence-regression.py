#!/usr/bin/env python3
"""Hermetic tests: no network, no real git store, no production mutation."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("source_evidence", Path(__file__).with_name("release-source-evidence.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
SHA = "a" * 40


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.calls = []

    def runner(self, args, **kwargs):
        self.calls.append(args)
        if "rev-parse" in args:
            output = SHA
        elif "cat-file" in args:
            output = "commit"
        else:
            output = ""
        return subprocess.CompletedProcess(args, 0, output, "")

    def collect(self, sha=SHA, runner=None):
        return module.collect(self.tmp.name, sha, run=runner or self.runner)

    def test_verified_local_signature_never_authorizes(self):
        result = self.collect()
        self.assertEqual(result["status"], "LOCAL_SIGNATURE_VERIFIED")
        self.assertFalse(result["eligible"])
        self.assertFalse(result["sourceVerified"])
        self.assertFalse(result["protectedBranchVerified"])
        self.assertFalse(result["checksVerified"])
        self.assertEqual(result["action"], "NO_MUTATION")

    def test_pinned_ref_and_exact_sha(self):
        self.collect()
        self.assertIn("refs/heads/master^{commit}", self.calls[0])
        self.assertEqual(self.calls[1][-2:], ["verify-commit", SHA])

    def test_invalid_sha(self):
        self.assertEqual(self.collect("bad")["reasonCode"], "INVALID_EXPECTED_SHA")
        self.assertEqual(self.calls, [])

    def test_mismatched_ref(self):
        def runner(args, **kwargs):
            if "rev-parse" in args:
                return subprocess.CompletedProcess(args, 0, "b" * 40, "")
            return self.runner(args, **kwargs)
        self.assertEqual(self.collect(runner=runner)["reasonCode"], "REF_SHA_MISMATCH")

    def test_unsigned_commit(self):
        def runner(args, **kwargs):
            if "verify-commit" in args:
                return subprocess.CompletedProcess(args, 1, "", "unsigned")
            return self.runner(args, **kwargs)
        self.assertEqual(self.collect(runner=runner)["reasonCode"], "LOCAL_GIT_VERIFICATION_FAILED")

    def test_wrong_object_type(self):
        def runner(args, **kwargs):
            if "cat-file" in args:
                return subprocess.CompletedProcess(args, 0, "tree", "")
            return self.runner(args, **kwargs)
        self.assertEqual(self.collect(runner=runner)["reasonCode"], "NOT_A_COMMIT")

    def test_timeout(self):
        def runner(args, **kwargs):
            raise subprocess.TimeoutExpired(args, 15)
        self.assertEqual(self.collect(runner=runner)["reasonCode"], "LOCAL_GIT_VERIFICATION_FAILED")

    def test_missing_store(self):
        self.assertEqual(module.collect("/nonexistent/git-store", SHA, run=self.runner)["reasonCode"], "INVALID_GIT_STORE")


if __name__ == "__main__":
    unittest.main()
