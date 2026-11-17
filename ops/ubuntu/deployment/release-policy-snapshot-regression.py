#!/usr/bin/python3
"""Read-only broker policy snapshot regression (no root or runtime required)."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from unittest import mock


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

    def test_authorization_generation_survives_same_owner_renewal(self):
        original = {"schemaVersion": 1, "authorizedSha": "a" * 40,
                    "enabledOperations": ["prepare", "validate"],
                    "authorizationLease": {"owner": "release", "expiresAt": 100}}
        renewed = dict(original, authorizationLease={"owner": "release", "expiresAt": 200})
        self.assertEqual(broker.authorization_generation(original),
                         broker.authorization_generation(renewed))
        self.assertNotEqual(broker.authorization_generation(original),
                            broker.authorization_generation(dict(renewed,
                                authorizationLease={"owner": "intruder", "expiresAt": 200})))
        self.assertNotEqual(broker.authorization_generation(original),
                            broker.authorization_generation(dict(renewed, authorizedSha="b" * 40)))

    def test_transaction_policy_generation_mismatch_rejected_before_busy(self):
        config = broker.PolicySnapshot({"schemaVersion": 1,
            "authorizedSha": "a" * 40, "enabledOperations": ["validate"]}, "d" * 64)
        transaction = {"transactionId": "e" * 32, "sha": "a" * 40,
                       "state": "prepared", "policyGeneration": "0" * 64,
                       "evidence": {"prepare": {"ok": True}}}
        with patch.object(broker, "policy", return_value=config), \
             patch.object(broker, "read_transaction", return_value={"ok": True, "transaction": transaction}), \
             patch.object(broker, "transaction_generation_matches", return_value=True):
            result = broker.handle_transaction({"version": 2, "operation": "validate",
                                                "transactionId": "e" * 32, "confirmed": True})
        self.assertEqual(result["status"], "RELEASE_TRANSACTION_POLICY_SUPERSEDED")

    def test_crash_recovery_marks_running_transaction_review_required(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            runs = base / "runs"
            transactions = base / "transactions"
            runs.mkdir()
            transactions.mkdir()
            identifier = "a" * 32
            (transactions / (identifier + ".json")).write_text(json.dumps({
                "transactionId": identifier, "state": "activate_running",
                "operation": "activate", "evidence": {"validate": {"ok": True}}}))
            with patch.object(broker, "RUNS", runs), \
                 patch.object(broker, "TRANSACTIONS", transactions), \
                 patch.object(broker, "protected", lambda _: None):
                broker.recover_interrupted()
                recovered = json.loads((transactions / (identifier + ".json")).read_text())
                self.assertEqual(recovered["state"], "review_required")
                self.assertEqual(recovered["operation"], "activate")

    def test_renewal_does_not_extend_expired_lease_at_worker_admission(self):
        config = broker.PolicySnapshot({"schemaVersion": 1, "authorizedSha": "a" * 40,
            "enabledOperations": ["prepare"],
            "authorizationLease": {"owner": "release", "expiresAt": 100}}, "d" * 64)
        snapshot = {"ok": True, "transaction": {"transactionId": "a" * 32,
                    "policyGeneration": broker.authorization_generation(config), "evidence": {}}}
        lock = unittest.mock.MagicMock()
        lock.open.return_value.__enter__.return_value.fileno.return_value = 10
        with patch.object(broker, "LOCK", lock), \
             patch.object(broker, "read_transaction", return_value=snapshot), \
             patch.object(broker, "policy", return_value=config), \
             patch.object(broker.time, "time", return_value=101), \
             patch.object(broker, "write_transaction") as write, \
             patch.object(broker, "execute_operation") as execute, \
             patch.object(broker.fcntl, "flock"):
            broker.BUSY.acquire()
            broker.transaction_worker("a" * 32, "prepare", "a" * 40, config)
        execute.assert_not_called()
        self.assertEqual(write.call_args.args[1]["evidence"]["prepare"]["status"],
                         "RELEASE_TRANSACTION_POLICY_SUPERSEDED")

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
