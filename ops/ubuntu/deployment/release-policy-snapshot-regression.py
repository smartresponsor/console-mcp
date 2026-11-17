#!/usr/bin/python3
"""Read-only broker policy snapshot regression (no root or runtime required)."""
import importlib.util
import json
import multiprocessing
import os
import signal
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from unittest import mock


SOURCE = Path(__file__).with_name("release-broker.py")
spec = importlib.util.spec_from_file_location("release_broker_snapshot", SOURCE)
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)

CAS_SOURCE = Path(__file__).with_name("release-policy-cas.py")
cas_spec = importlib.util.spec_from_file_location("release_policy_cas_snapshot", CAS_SOURCE)
cas = importlib.util.module_from_spec(cas_spec)
cas_spec.loader.exec_module(cas)


def _broker_process_persist_then_die(runs_path, transactions_path):
    broker.RUNS = Path(runs_path)
    broker.TRANSACTIONS = Path(transactions_path)
    broker.record("c" * 32, {
        "runId": "c" * 32, "operation": "prepare", "state": "running",
        "startedAt": 100,
    })
    broker.write_transaction("d" * 32, {
        "schemaVersion": 1, "transactionId": "d" * 32, "sha": "a" * 40,
        "operation": "validate", "state": "validate_running",
        "updatedAt": 100, "evidence": {"prepare": {"ok": True}},
    })
    os.kill(os.getpid(), signal.SIGKILL)


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

    def test_long_running_controller_lease_expiry_fails_closed(self):
        config = broker.PolicySnapshot({"schemaVersion": 1, "authorizedSha": "a" * 40,
            "enabledOperations": ["prepare"],
            "authorizationLease": {"owner": "release", "expiresAt": 150}}, "d" * 64)
        transaction = {"transactionId": "a" * 32,
                       "policyGeneration": broker.authorization_generation(config), "evidence": {}}
        lock = mock.MagicMock()
        moments = iter([100, 200, 201])
        with patch.object(broker, "LOCK", lock), \
             patch.object(broker, "read_transaction", return_value={"ok": True, "transaction": transaction}), \
             patch.object(broker, "policy", return_value=config), \
             patch.object(broker.time, "time", side_effect=lambda: next(moments)), \
             patch.object(broker, "write_transaction") as write, \
             patch.object(broker, "execute_operation", return_value={"ok": True}), \
             patch.object(broker.fcntl, "flock"):
            broker.BUSY.acquire()
            broker.transaction_worker("a" * 32, "prepare", "a" * 40, config)
        self.assertEqual(write.call_args.args[1]["state"], "prepare_failed")
        self.assertEqual(write.call_args.args[1]["evidence"]["prepare"]["status"],
                         "RELEASE_TRANSACTION_POLICY_SUPERSEDED")

    def test_rollback_rejects_stale_policy_generation(self):
        config = broker.PolicySnapshot({"schemaVersion": 1,
            "authorizedSha": "a" * 40, "enabledOperations": ["rollback"]}, "d" * 64)
        transaction = {"transactionId": "e" * 32, "sha": "a" * 40,
                       "state": "activated", "policyGeneration": "0" * 64,
                       "evidence": {"activate": {"ok": True}}}
        with patch.object(broker, "policy", return_value=config), \
             patch.object(broker, "read_transaction", return_value={"ok": True, "transaction": transaction}), \
             patch.object(broker, "transaction_generation_matches", return_value=True):
            result = broker.handle_transaction({"version": 2, "operation": "rollback",
                                                "transactionId": "e" * 32, "confirmed": True})
        self.assertEqual(result["status"], "RELEASE_TRANSACTION_POLICY_SUPERSEDED")

    def test_schema_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            path = base / "policy.json"
            path.write_text('{"schemaVersion": 999}')
            with patch.object(broker, "BASE", base), patch.object(broker, "POLICY", path), \
                 patch.object(broker, "protected", lambda _: None):
                with self.assertRaisesRegex(RuntimeError, "POLICY_INVALID"):
                    broker.policy()


    @unittest.skipUnless(os.geteuid() == 0, "root-only real CAS lease-renewal integration")
    def test_same_owner_lease_renewal_sustains_long_running_controller(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            os.chmod(base, 0o700)
            policy_path = base / "broker-policy.json"
            lock_path = base / "broker.lock"
            initial_policy = {
                "schemaVersion": 1,
                "authorizedSha": "a" * 40,
                "enabledOperations": ["prepare"],
                "authorizationLease": {"owner": "release-admin", "expiresAt": 150},
            }
            policy_path.write_text(json.dumps(initial_policy))
            os.chmod(policy_path, 0o600)
            initial_raw = policy_path.read_bytes()
            initial_config = broker.PolicySnapshot(
                initial_policy, broker.hashlib.sha256(initial_raw).hexdigest())
            transaction_id = "b" * 32
            transaction = {
                "transactionId": transaction_id,
                "sha": "a" * 40,
                "policyGeneration": broker.authorization_generation(initial_config),
                "state": "prepare_running",
                "evidence": {},
            }
            snapshot = {"ok": True, "transaction": transaction}
            moments = iter((100, 200, 201))
            writes = []

            def current_policy():
                raw = policy_path.read_bytes()
                return broker.PolicySnapshot(json.loads(raw), broker.hashlib.sha256(raw).hexdigest())

            def long_running_controller(operation, sha, config):
                before = cas.inspect(policy_path)
                renewed = cas.replace_if_generation(
                    policy_path, lock_path, before["generation"], "release-admin", 100,
                    {"schemaVersion": 1, "authorizedSha": "a" * 40,
                     "enabledOperations": ["prepare"]}, now=140)
                self.assertEqual(renewed["expiresAt"], 240)
                return {"ok": True, "status": "CONTROLLER_COMPLETED"}

            lock = mock.MagicMock()
            with patch.object(broker, "LOCK", lock), \
                 patch.object(broker, "read_transaction", return_value=snapshot), \
                 patch.object(broker, "policy", side_effect=current_policy), \
                 patch.object(broker.time, "time", side_effect=lambda: next(moments)), \
                 patch.object(broker, "write_transaction", side_effect=lambda key, value: writes.append(value.copy())), \
                 patch.object(broker, "execute_operation", side_effect=long_running_controller), \
                 patch.object(broker, "deployment_binding", return_value={"sourceSha": "a" * 40}), \
                 patch.object(broker.fcntl, "flock"):
                self.assertTrue(broker.BUSY.acquire())
                broker.transaction_worker(transaction_id, "prepare", "a" * 40, initial_config)

            self.assertEqual(len(writes), 1)
            self.assertEqual(writes[0]["state"], "prepared")
            self.assertTrue(writes[0]["evidence"]["prepare"]["ok"])
            final_policy = cas.inspect(policy_path)["policy"]
            self.assertEqual(final_policy["authorizationLease"]["owner"], "release-admin")
            self.assertEqual(final_policy["authorizationLease"]["expiresAt"], 240)


    @unittest.skipUnless(os.geteuid() == 0, "root-only real broker process-kill recovery")
    def test_process_kill_restart_recovers_run_and_transaction_journals(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            os.chmod(base, 0o700)
            runs = base / "runs"
            transactions = base / "transactions"
            context = multiprocessing.get_context("fork")
            child = context.Process(target=_broker_process_persist_then_die,
                                    args=(str(runs), str(transactions)))
            child.start()
            child.join(15)
            self.assertFalse(child.is_alive())
            self.assertEqual(child.exitcode, -signal.SIGKILL)

            with patch.object(broker, "RUNS", runs), \
                 patch.object(broker, "TRANSACTIONS", transactions), \
                 patch.object(broker.time, "time", return_value=200):
                broker.recover_interrupted()
                recovered_run = json.loads((runs / ("c" * 32 + ".json")).read_text())
                recovered_transaction = json.loads(
                    (transactions / ("d" * 32 + ".json")).read_text())

            self.assertEqual(recovered_run["state"], "interrupted")
            self.assertEqual(recovered_run["result"]["status"],
                             "RELEASE_OPERATION_INTERRUPTED_REVIEW_REQUIRED")
            self.assertEqual(recovered_transaction["state"], "review_required")
            self.assertEqual(recovered_transaction["operation"], "validate")


if __name__ == "__main__":
    unittest.main()
