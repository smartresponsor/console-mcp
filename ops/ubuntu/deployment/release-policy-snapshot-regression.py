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


def isolated_protected(path):
    metadata = path.lstat()
    if path.is_symlink() or metadata.st_uid != os.geteuid() or metadata.st_mode & 0o022:
        raise RuntimeError("RELEASE_BROKER_UNTRUSTED_ADMIN_PATH")


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
                 patch.object(broker, "_trusted_policy_read", side_effect=lambda _: path.read_bytes()):
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
                 patch.object(broker, "_trusted_policy_read", side_effect=lambda _: path.read_bytes()):
                with self.assertRaisesRegex(RuntimeError, "POLICY_INVALID"):
                    broker.policy()


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
                before = cas._inspect_for_test(policy_path, trusted_uid=os.geteuid())
                renewed = cas._replace_if_generation_for_test(
                    policy_path, lock_path, before["generation"], "release-admin", 100,
                    {"schemaVersion": 1, "authorizedSha": "a" * 40,
                     "enabledOperations": ["prepare"]}, now=140, trusted_uid=os.geteuid())
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
            final_policy = cas._inspect_for_test(policy_path, trusted_uid=os.geteuid())["policy"]
            self.assertEqual(final_policy["authorizationLease"]["owner"], "release-admin")
            self.assertEqual(final_policy["authorizationLease"]["expiresAt"], 240)


    def test_process_kill_restart_recovers_run_and_transaction_journals(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            os.chmod(base, 0o700)
            runs = base / "runs"
            transactions = base / "transactions"
            context = multiprocessing.get_context("fork")
            child = context.Process(target=_broker_process_persist_then_die,
                                    args=(str(runs), str(transactions)))
            with patch.object(broker, "protected", isolated_protected):
                child.start()
            child.join(15)
            self.assertFalse(child.is_alive())
            self.assertEqual(child.exitcode, -signal.SIGKILL)

            with patch.object(broker, "RUNS", runs), \
                 patch.object(broker, "TRANSACTIONS", transactions), \
                 patch.object(broker, "protected", isolated_protected), \
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


    def test_v1_worker_rejects_revoked_policy_before_controller(self):
        initial = broker.PolicySnapshot({
            "schemaVersion": 1, "authorizedSha": "a" * 40,
            "enabledOperations": ["prepare"],
            "authorizationLease": {"owner": "operator", "expiresAt": 500}
        }, "a" * 64)
        revoked = broker.PolicySnapshot({
            "schemaVersion": 1, "authorizedSha": "b" * 40,
            "enabledOperations": ["prepare"],
            "authorizationLease": {"owner": "operator", "expiresAt": 500}
        }, "b" * 64)
        records = []
        with tempfile.TemporaryDirectory() as folder:
            lock = Path(folder) / "lock"
            with patch.object(broker, "LOCK", lock), \
                 patch.object(broker, "BUSY", mock.Mock()), \
                 patch.object(broker, "policy", return_value=revoked), \
                 patch.object(broker, "record", side_effect=lambda _, item: records.append(item)), \
                 patch.object(broker, "execute_operation") as execute, \
                 patch.object(broker.time, "time", return_value=100):
                broker.worker("a" * 32, "prepare", "a" * 40, initial)
        execute.assert_not_called()
        self.assertEqual(records[-1]["result"]["status"], "RELEASE_OPERATION_POLICY_SUPERSEDED")

    def test_v1_worker_rejects_expired_lease_before_controller(self):
        initial = broker.PolicySnapshot({
            "schemaVersion": 1, "authorizedSha": "a" * 40,
            "enabledOperations": ["prepare"],
            "authorizationLease": {"owner": "operator", "expiresAt": 500}
        }, "a" * 64)
        expired = broker.PolicySnapshot(dict(initial, authorizationLease={
            "owner": "operator", "expiresAt": 99}), "b" * 64)
        records = []
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(broker, "LOCK", Path(folder) / "lock"), \
                 patch.object(broker, "BUSY", mock.Mock()), \
                 patch.object(broker, "policy", return_value=expired), \
                 patch.object(broker, "record", side_effect=lambda _, item: records.append(item)), \
                 patch.object(broker, "execute_operation") as execute, \
                 patch.object(broker.time, "time", return_value=100):
                broker.worker("a" * 32, "prepare", "a" * 40, initial)
        execute.assert_not_called()
        self.assertEqual(records[-1]["result"]["status"], "RELEASE_OPERATION_POLICY_SUPERSEDED")

    def test_v1_worker_rechecks_policy_after_controller(self):
        initial = broker.PolicySnapshot({
            "schemaVersion": 1, "authorizedSha": "a" * 40,
            "enabledOperations": ["prepare"],
            "authorizationLease": {"owner": "operator", "expiresAt": 500}
        }, "a" * 64)
        revoked = broker.PolicySnapshot(dict(initial, enabledOperations=[]), "b" * 64)
        records = []
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(broker, "LOCK", Path(folder) / "lock"), \
                 patch.object(broker, "BUSY", mock.Mock()), \
                 patch.object(broker, "policy", side_effect=[initial, revoked]), \
                 patch.object(broker, "record", side_effect=lambda _, item: records.append(item)), \
                 patch.object(broker, "execute_operation", return_value={"ok": True}) as execute, \
                 patch.object(broker.time, "time", return_value=100):
                broker.worker("a" * 32, "prepare", "a" * 40, initial)
        execute.assert_called_once()
        self.assertEqual(records[-1]["state"], "failed")
        self.assertEqual(records[-1]["result"]["status"], "RELEASE_OPERATION_POLICY_SUPERSEDED")


    def test_policy_reader_rejects_untrusted_ancestor_without_mock(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "policy.json"
            path.write_text('{"schemaVersion":1}')
            with self.assertRaisesRegex(RuntimeError, "UNTRUSTED_ADMIN_PATH"):
                broker._trusted_policy_read(path)

    def test_policy_reader_rejects_hardlink_and_writable_policy(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "policy.json"
            path.write_text('{"schemaVersion":1}')
            alias = Path(folder) / "alias.json"
            os.link(path, alias)
            with patch.object(broker, "_trusted_policy_directory",
                              side_effect=lambda _: os.open(folder, os.O_RDONLY | os.O_DIRECTORY)), \
                 patch.object(broker.os, "fstat", side_effect=lambda fd: self._fake_root_stat(fd)):
                with self.assertRaisesRegex(RuntimeError, "UNTRUSTED_ADMIN_PATH"):
                    broker._trusted_policy_read(path)
            alias.unlink()
            os.chmod(path, 0o666)
            with patch.object(broker, "_trusted_policy_directory",
                              side_effect=lambda _: os.open(folder, os.O_RDONLY | os.O_DIRECTORY)), \
                 patch.object(broker.os, "fstat", side_effect=lambda fd: self._fake_root_stat(fd)):
                with self.assertRaisesRegex(RuntimeError, "UNTRUSTED_ADMIN_PATH"):
                    broker._trusted_policy_read(path)

    @staticmethod
    def _fake_root_stat(fd):
        from types import SimpleNamespace
        st = os.stat("/proc/self/fd/" + str(fd))
        return SimpleNamespace(st_uid=0, st_mode=st.st_mode, st_nlink=st.st_nlink)

    def test_policy_reader_inode_bound_during_pathname_swap(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "policy.json"
            original = b'{"schemaVersion":1,"authorizedSha":"old"}'
            replacement = b'{"schemaVersion":1,"authorizedSha":"new"}'
            path.write_bytes(original)
            other = Path(folder) / "other.json"
            other.write_bytes(replacement)
            original_open = broker.os.open
            switched = [False]
            def swap_after_open(name, flags, *args, **kwargs):
                fd = original_open(name, flags, *args, **kwargs)
                if name == "policy.json" and not switched[0]:
                    switched[0] = True
                    os.replace(other, path)
                return fd
            with patch.object(broker, "_trusted_policy_directory",
                              side_effect=lambda _: original_open(folder, os.O_RDONLY | os.O_DIRECTORY)), \
                 patch.object(broker.os, "open", side_effect=swap_after_open), \
                 patch.object(broker.os, "fstat", side_effect=lambda fd: self._fake_root_stat(fd)):
                with self.assertRaisesRegex(RuntimeError, "UNTRUSTED_ADMIN_PATH"):
                    broker._trusted_policy_read(path)
            self.assertTrue(switched[0])
            self.assertEqual(path.read_bytes(), replacement)


    def test_policy_reader_rejects_extended_acl_even_with_safe_mode(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "policy.json"
            path.write_text('{"schemaVersion":1}')
            os.chmod(path, 0o600)
            with patch.object(broker, "_trusted_policy_directory",
                              side_effect=lambda _: os.open(folder, os.O_RDONLY | os.O_DIRECTORY)), \
                 patch.object(broker.os, "fstat", side_effect=lambda fd: self._fake_root_stat(fd)), \
                 patch.object(broker.os, "getxattr", return_value=b"extended-acl"):
                with self.assertRaisesRegex(RuntimeError, "UNTRUSTED_ADMIN_PATH"):
                    broker._trusted_policy_read(path)

    def test_policy_reader_rejects_unexpected_acl_read_error(self):
        import errno
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "policy.json"
            path.write_text('{"schemaVersion":1}')
            with patch.object(broker, "_trusted_policy_directory",
                              side_effect=lambda _: os.open(folder, os.O_RDONLY | os.O_DIRECTORY)), \
                 patch.object(broker.os, "fstat", side_effect=lambda fd: self._fake_root_stat(fd)), \
                 patch.object(broker.os, "getxattr", side_effect=OSError(errno.EACCES, "denied")):
                with self.assertRaisesRegex(RuntimeError, "UNTRUSTED_ADMIN_PATH"):
                    broker._trusted_policy_read(path)


if __name__ == "__main__":
    unittest.main()
