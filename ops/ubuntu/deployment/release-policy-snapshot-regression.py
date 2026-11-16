#!/usr/bin/python3
"""Read-only broker policy snapshot regression (no root or runtime required)."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).with_name("release-broker.py")
spec = importlib.util.spec_from_file_location("release_broker_snapshot", SOURCE)
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)


class PolicySnapshotRegression(unittest.TestCase):
    def test_digest_and_authorization_share_single_read(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            path = base / "policy.json"
            path.write_text(json.dumps({
                "schemaVersion": 1, "authorizedSha": "a" * 40,
                "enabledOperations": ["prepare"]
            }))
            with patch.object(broker, "BASE", base), patch.object(broker, "POLICY", path), \
                 patch.object(broker, "protected", lambda _: None):
                snapshot = broker.policy()
                expected_digest = broker.hashlib.sha256(path.read_bytes()).hexdigest()
                path.write_text(json.dumps({
                    "schemaVersion": 1, "authorizedSha": "b" * 40,
                    "enabledOperations": ["validate"]
                }))
                result = broker.authorization_denied("c" * 40, snapshot)
                self.assertEqual(result["authorization"]["policyGeneration"], expected_digest)
                self.assertEqual(result["authorization"]["authorizedSha"], "a" * 40)
                self.assertEqual(result["authorization"]["enabledOperations"], ["prepare"])
                self.assertEqual(result["requestedSha"], "c" * 40)

    def test_lease_validation(self):
        self.assertIsNone(broker.authorization_lease_failure({}, now=100))
        self.assertEqual(broker.authorization_lease_failure(
            {"authorizationLease": {"owner": "net282", "expiresAt": 100}}, now=100),
            "RELEASE_POLICY_LEASE_EXPIRED")
        self.assertEqual(broker.authorization_lease_failure(
            {"authorizationLease": {"owner": "net282", "expiresAt": True}}, now=100),
            "RELEASE_POLICY_LEASE_INVALID")
        self.assertEqual(broker.authorization_lease_failure(
            {"authorizationLease": {"owner": "net282", "expiresAt": 101}}, now=100),
            None)

    def test_v1_rejects_expired_lease_before_sha_check(self):
        config = broker.PolicySnapshot({
            "schemaVersion": 1, "authorizedSha": "a" * 40,
            "enabledOperations": ["prepare"],
            "authorizationLease": {"owner": "release", "expiresAt": 100},
        }, "f" * 64)
        with patch.object(broker, "policy", return_value=config), \
             patch.object(broker.time, "time", return_value=101):
            result = broker.handle({
                "version": 1, "operation": "prepare", "sha": "b" * 40
            })
        self.assertEqual(result["status"], "RELEASE_POLICY_LEASE_EXPIRED")
        self.assertEqual(result["authorization"]["policyGeneration"], "f" * 64)

    def test_v1_sha_denial_contains_snapshot_identity(self):
        config = broker.PolicySnapshot({
            "schemaVersion": 1, "authorizedSha": "a" * 40,
            "enabledOperations": ["prepare"]
        }, "e" * 64)
        with patch.object(broker, "policy", return_value=config):
            result = broker.handle({
                "version": 1, "operation": "prepare", "sha": "b" * 40
            })
        self.assertEqual(result["status"], "RELEASE_SHA_NOT_AUTHORIZED")
        self.assertEqual(result["authorization"]["policyGeneration"], "e" * 64)

    def test_nonfinite_lease_rejected(self):
        for expiry in (float("nan"), float("inf"), -float("inf")):
            self.assertEqual(broker.authorization_lease_failure({
                "authorizationLease": {"owner": "release", "expiresAt": expiry}
            }, now=100), "RELEASE_POLICY_LEASE_INVALID")

    def test_schema_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            path = base / "policy.json"
            path.write_text('{"schemaVersion": 999}')
            with patch.object(broker, "BASE", base), patch.object(broker, "POLICY", path), \
                 patch.object(broker, "protected", lambda _: None):
                with self.assertRaisesRegex(RuntimeError, "POLICY_INVALID"):
                    broker.policy()


if __name__ == "__main__":
    unittest.main()
