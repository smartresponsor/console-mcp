#!/usr/bin/python3
"""Regression coverage for the isolated release-policy CAS primitive."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest


MODULE = Path(__file__).with_name("release-policy-cas.py")
spec = importlib.util.spec_from_file_location("release_policy_cas", MODULE)
cas = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cas)


class PolicyCasTest(unittest.TestCase):
    def test_generation_is_content_addressed(self):
        self.assertEqual(len(cas.generation(b"{}")), 64)
        self.assertNotEqual(cas.generation(b"{}"), cas.generation(b"{ }"))

    def test_rejects_invalid_inputs_before_io(self):
        with self.assertRaisesRegex(ValueError, "OWNER_OR_LEASE"):
            cas.replace_if_generation(Path("/nonexistent"), Path("/nonexistent.lock"),
                                      "0" * 64, "", 30, {"schemaVersion": 1})
        with self.assertRaisesRegex(ValueError, "GENERATION_INVALID"):
            cas.replace_if_generation(Path("/nonexistent"), Path("/nonexistent.lock"),
                                      "z" * 64, "release", 30, {"schemaVersion": 1})

    def test_rejects_nonfinite_and_boolean_lease_duration_before_io(self):
        for duration in (True, False, float("nan"), float("inf"), float("-inf")):
            with self.subTest(duration=duration):
                with self.assertRaisesRegex(ValueError, "OWNER_OR_LEASE_INVALID"):
                    cas.replace_if_generation(Path("/nonexistent"), Path("/nonexistent.lock"),
                                              "0" * 64, "release", duration,
                                              {"schemaVersion": 1})

    @unittest.skipUnless(os.geteuid() == 0, "root-only trusted-policy regression")
    def test_nonfinite_stored_lease_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            os.chmod(base, 0o700)
            policy = base / "broker-policy.json"
            policy.write_text(json.dumps({"schemaVersion": 1,
                "authorizationLease": {"owner": "other", "expiresAt": float("nan")}}))
            os.chmod(policy, 0o600)
            with self.assertRaisesRegex(RuntimeError, "LEASE_INVALID"):
                cas.replace_if_generation(policy, base / "broker.lock",
                                          cas.inspect(policy)["generation"], "release", 30,
                                          {"schemaVersion": 1}, now=0)

    @unittest.skipUnless(os.geteuid() == 0, "root-only trusted-policy regression")
    def test_cas_conflict_and_owner_lease(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            os.chmod(base, 0o700)
            policy = base / "broker-policy.json"
            lock = base / "broker.lock"
            policy.write_text(json.dumps({"schemaVersion": 1, "authorizedSha": "a" * 40}))
            os.chmod(policy, 0o600)
            initial = cas.inspect(policy)["generation"]
            desired = {"schemaVersion": 1, "authorizedSha": "b" * 40,
                       "enabledOperations": ["prepare"]}
            result = cas.replace_if_generation(policy, lock, initial, "net282", 120, desired, now=1000)
            self.assertNotEqual(result["generation"], initial)
            with self.assertRaisesRegex(cas.PolicyConflict, "GENERATION_CONFLICT"):
                cas.replace_if_generation(policy, lock, initial, "net282", 120, desired, now=1001)
            with self.assertRaisesRegex(cas.PolicyConflict, "LEASE_HELD"):
                cas.replace_if_generation(policy, lock, result["generation"], "m5", 120, desired, now=1001)
            renewed = cas.replace_if_generation(policy, lock, result["generation"], "m5", 120, desired, now=1121)
            self.assertEqual(renewed["owner"], "m5")
            self.assertEqual(policy.stat().st_mode & 0o777, 0o600)

    @unittest.skipUnless(os.geteuid() == 0, "root-only trusted-policy regression")
    def test_boolean_lease_expiry_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            os.chmod(base, 0o700)
            policy = base / "broker-policy.json"
            policy.write_text(json.dumps({
                "schemaVersion": 1,
                "authorizationLease": {"owner": "other", "expiresAt": True}
            }))
            os.chmod(policy, 0o600)
            with self.assertRaisesRegex(RuntimeError, "LEASE_INVALID"):
                cas.replace_if_generation(
                    policy, base / "broker.lock",
                    cas.inspect(policy)["generation"], "release", 30,
                    {"schemaVersion": 1}, now=0)

    @unittest.skipUnless(os.geteuid() == 0, "root-only trusted-policy regression")
    def test_concurrent_writers_only_one_generation_wins(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            os.chmod(base, 0o700)
            policy = base / "broker-policy.json"
            policy.write_text(json.dumps({"schemaVersion": 1, "authorizedSha": "a" * 40,
                                          "enabledOperations": ["prepare"]}))
            os.chmod(policy, 0o600)
            initial = cas.inspect(policy)["generation"]
            barrier = threading.Barrier(3)
            results = []
            mutex = threading.Lock()

            def contender(owner):
                barrier.wait()
                try:
                    cas.replace_if_generation(policy, base / "broker.lock", initial, owner, 120,
                        {"schemaVersion": 1, "authorizedSha": "b" * 40,
                         "enabledOperations": ["prepare"]}, now=100)
                    outcome = "won"
                except cas.PolicyConflict:
                    outcome = "conflict"
                with mutex:
                    results.append(outcome)

            threads = [threading.Thread(target=contender, args=(owner,))
                       for owner in ("alpha", "beta")]
            for thread in threads:
                thread.start()
            barrier.wait()
            for thread in threads:
                thread.join(timeout=5)
                self.assertFalse(thread.is_alive())
            self.assertCountEqual(results, ["won", "conflict"])
            self.assertEqual(cas.inspect(policy)["policy"]["authorizedSha"], "b" * 40)

    @unittest.skipUnless(os.geteuid() == 0, "root-only trusted-policy regression")
    def test_symlink_lock_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            os.chmod(base, 0o700)
            policy = base / "broker-policy.json"
            policy.write_text('{"schemaVersion":1}')
            os.chmod(policy, 0o600)
            lock = base / "broker.lock"
            lock.symlink_to(policy)
            with self.assertRaises(OSError):
                cas.replace_if_generation(policy, lock, cas.inspect(policy)["generation"],
                                          "release", 30, {"schemaVersion": 1})


if __name__ == "__main__":
    unittest.main()
