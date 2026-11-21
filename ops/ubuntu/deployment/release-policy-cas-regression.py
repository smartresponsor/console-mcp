#!/usr/bin/python3
"""Regression coverage for the isolated release-policy CAS primitive."""
import importlib.util
import inspect as pyinspect
import json
import multiprocessing
import os
from pathlib import Path
import stat
import signal
import tempfile
import threading
import unittest
from unittest.mock import patch


MODULE = Path(__file__).with_name("release-policy-cas.py")
spec = importlib.util.spec_from_file_location("release_policy_cas", MODULE)
cas = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cas)


def test_inspect(path):
    return cas._inspect_for_test(path, trusted_uid=os.geteuid())


def test_replace_if_generation(*args, **kwargs):
    kwargs["trusted_uid"] = os.geteuid()
    return cas._replace_if_generation_for_test(*args, now=kwargs.get('now'), trusted_uid=kwargs['trusted_uid'])


def _process_cas_contender(policy_path, lock_path, expected, owner, start, results):
    start.wait(10)
    try:
        test_replace_if_generation(Path(policy_path), Path(lock_path), expected, owner, 120,
                                  {"schemaVersion": 1, "authorizedSha": "b" * 40,
                                   "enabledOperations": ["prepare"]}, now=100)
        results.put("won")
    except cas.PolicyConflict:
        results.put("conflict")
    except BaseException as error:
        results.put("error:" + type(error).__name__ + ":" + str(error))


def _process_pause_after_atomic_replace(policy_path, lock_path, expected, ready):
    original_fsync = cas.os.fsync
    def pause_directory_fsync(fd):
        if stat.S_ISDIR(os.fstat(fd).st_mode):
            ready.set()
            threading.Event().wait(30)
        return original_fsync(fd)
    cas.os.fsync = pause_directory_fsync
    test_replace_if_generation(Path(policy_path), Path(lock_path), expected, "crash-writer", 120,
                              {"schemaVersion": 1, "authorizedSha": "c" * 40,
                               "enabledOperations": ["prepare"]}, now=100)


class PolicyCasTest(unittest.TestCase):
    def test_generation_is_content_addressed(self):
        self.assertEqual(len(cas.generation(b"{}")), 64)
        self.assertNotEqual(cas.generation(b"{}"), cas.generation(b"{ }"))

    def test_rejects_invalid_inputs_before_io(self):
        with self.assertRaisesRegex(ValueError, "OWNER_OR_LEASE"):
            test_replace_if_generation(Path("/nonexistent"), Path("/nonexistent.lock"),
                                      "0" * 64, "", 30, {"schemaVersion": 1})
        with self.assertRaisesRegex(ValueError, "GENERATION_INVALID"):
            test_replace_if_generation(Path("/nonexistent"), Path("/nonexistent.lock"),
                                      "z" * 64, "release", 30, {"schemaVersion": 1, "authorizedSha": "b" * 40,
                                                        "enabledOperations": ["prepare"]})

    def test_rejects_nonfinite_and_boolean_lease_duration_before_io(self):
        for duration in (True, False, float("nan"), float("inf"), float("-inf")):
            with self.subTest(duration=duration):
                with self.assertRaisesRegex(ValueError, "OWNER_OR_LEASE_INVALID"):
                    test_replace_if_generation(Path("/nonexistent"), Path("/nonexistent.lock"),
                                              "0" * 64, "release", duration,
                                              {"schemaVersion": 1})

    def test_nonfinite_stored_lease_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            os.chmod(base, 0o700)
            policy = base / "broker-policy.json"
            policy.write_text(json.dumps({"schemaVersion": 1,
                "authorizationLease": {"owner": "other", "expiresAt": float("nan")}}))
            os.chmod(policy, 0o600)
            with self.assertRaisesRegex(RuntimeError, "LEASE_INVALID"):
                test_replace_if_generation(policy, base / "broker.lock",
                                          test_inspect(policy)["generation"], "release", 30,
                                          {"schemaVersion": 1, "authorizedSha": "b" * 40,
                                           "enabledOperations": ["prepare"]}, now=0)

    def test_cas_conflict_and_owner_lease(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            os.chmod(base, 0o700)
            policy = base / "broker-policy.json"
            lock = base / "broker.lock"
            policy.write_text(json.dumps({"schemaVersion": 1, "authorizedSha": "a" * 40, "enabledOperations": ["prepare"]}))
            os.chmod(policy, 0o600)
            initial = test_inspect(policy)["generation"]
            desired = {"schemaVersion": 1, "authorizedSha": "b" * 40,
                       "enabledOperations": ["prepare"]}
            result = test_replace_if_generation(policy, lock, initial, "net282", 120, desired, now=1000)
            self.assertNotEqual(result["generation"], initial)
            with self.assertRaisesRegex(cas.PolicyConflict, "GENERATION_CONFLICT"):
                test_replace_if_generation(policy, lock, initial, "net282", 120, desired, now=1001)
            with self.assertRaisesRegex(cas.PolicyConflict, "LEASE_HELD"):
                test_replace_if_generation(policy, lock, result["generation"], "m5", 120, desired, now=1001)
            renewed = test_replace_if_generation(policy, lock, result["generation"], "m5", 120, desired, now=1121)
            self.assertEqual(renewed["owner"], "m5")
            self.assertEqual(policy.stat().st_mode & 0o777, 0o600)

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
                test_replace_if_generation(
                    policy, base / "broker.lock",
                    test_inspect(policy)["generation"], "release", 30,
                    {"schemaVersion": 1, "authorizedSha": "b" * 40,
                     "enabledOperations": ["prepare"]}, now=0)

    def test_concurrent_writers_only_one_generation_wins(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            os.chmod(base, 0o700)
            policy = base / "broker-policy.json"
            policy.write_text(json.dumps({"schemaVersion": 1, "authorizedSha": "a" * 40,
                                          "enabledOperations": ["prepare"]}))
            os.chmod(policy, 0o600)
            initial = test_inspect(policy)["generation"]
            barrier = threading.Barrier(3)
            results = []
            mutex = threading.Lock()

            def contender(owner):
                barrier.wait()
                try:
                    test_replace_if_generation(policy, base / "broker.lock", initial, owner, 120,
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
            self.assertEqual(test_inspect(policy)["policy"]["authorizedSha"], "b" * 40)

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
                test_replace_if_generation(policy, lock, test_inspect(policy)["generation"],
                                          "release", 30, {"schemaVersion": 1, "authorizedSha": "b" * 40,
                                                          "enabledOperations": ["prepare"]})


    def test_root_owned_sticky_tmp_ancestor_is_accepted(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            os.chmod(base, 0o700)
            fd = cas._open_directory_chain(base, trusted_uid=os.geteuid())
            try:
                self.assertEqual(os.fstat(fd).st_uid, os.geteuid())
                self.assertTrue(cas._trusted_directory_stat(os.stat('/tmp'), os.geteuid()))
            finally:
                os.close(fd)

    def test_writable_nonsticky_ancestor_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            unsafe = Path(temp) / "unsafe"
            unsafe.mkdir()
            os.chmod(unsafe, 0o777)
            nested = unsafe / "nested"
            nested.mkdir()
            os.chmod(nested, 0o700)
            with self.assertRaisesRegex(RuntimeError, "UNTRUSTED_DIRECTORY"):
                cas._open_directory_chain(nested, trusted_uid=os.geteuid())

    def test_symlink_ancestor_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            real = base / "real"
            real.mkdir()
            os.chmod(real, 0o700)
            link = base / "link"
            link.symlink_to(real, target_is_directory=True)
            with self.assertRaises(OSError):
                cas._open_directory_chain(link, trusted_uid=os.geteuid())

    def test_independent_process_writers_only_one_generation_wins(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            os.chmod(base, 0o700)
            policy = base / "broker-policy.json"
            lock = base / "broker.lock"
            policy.write_text(json.dumps({"schemaVersion": 1, "authorizedSha": "a" * 40,
                                          "enabledOperations": ["prepare"]}))
            os.chmod(policy, 0o600)
            expected = test_inspect(policy)["generation"]
            context = multiprocessing.get_context("fork")
            start = context.Event()
            results = context.Queue()
            processes = [context.Process(target=_process_cas_contender,
                         args=(str(policy), str(lock), expected, owner, start, results))
                         for owner in ("proc-alpha", "proc-beta")]
            for process in processes:
                process.start()
            start.set()
            outcomes = [results.get(timeout=15), results.get(timeout=15)]
            for process in processes:
                process.join(15)
                self.assertFalse(process.is_alive())
                self.assertEqual(process.exitcode, 0)
            self.assertCountEqual(outcomes, ["won", "conflict"])
            self.assertEqual(test_inspect(policy)["policy"]["authorizedSha"], "b" * 40)

    def test_process_kill_after_atomic_replace_leaves_complete_new_generation(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            os.chmod(base, 0o700)
            policy = base / "broker-policy.json"
            lock = base / "broker.lock"
            policy.write_text(json.dumps({"schemaVersion": 1, "authorizedSha": "a" * 40,
                                          "enabledOperations": ["prepare"]}))
            os.chmod(policy, 0o600)
            expected = test_inspect(policy)["generation"]
            context = multiprocessing.get_context("fork")
            ready = context.Event()
            process = context.Process(target=_process_pause_after_atomic_replace,
                                      args=(str(policy), str(lock), expected, ready))
            process.start()
            self.assertTrue(ready.wait(15), "writer never reached post-rename directory fsync")
            os.kill(process.pid, signal.SIGKILL)
            process.join(10)
            self.assertFalse(process.is_alive())
            self.assertEqual(process.exitcode, -signal.SIGKILL)
            snapshot = test_inspect(policy)
            self.assertEqual(snapshot["policy"]["authorizedSha"], "c" * 40)
            self.assertNotEqual(snapshot["generation"], expected)
            self.assertEqual(policy.stat().st_mode & 0o777, 0o600)


    def test_policy_and_lock_hardlink_alias_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            os.chmod(base, 0o700)
            policy = base / "broker-policy.json"
            lock = base / "broker.lock"
            policy.write_text(json.dumps({"schemaVersion": 1, "authorizedSha": "a" * 40,
                                          "enabledOperations": ["prepare"]}))
            os.chmod(policy, 0o600)
            os.link(policy, lock)
            with self.assertRaisesRegex(RuntimeError, "LOCK_ALIASED"):
                test_replace_if_generation(
                    policy, lock, test_inspect(policy)["generation"], "release", 30,
                    {"schemaVersion": 1, "authorizedSha": "b" * 40,
                     "enabledOperations": ["prepare"]}, now=100)


    def test_production_default_rejects_non_root_owned_ancestors(self):
        self.assertNotIn("trusted_uid", pyinspect.signature(cas.inspect).parameters)
        self.assertNotIn("trusted_uid", pyinspect.signature(cas.replace_if_generation).parameters)
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            if os.geteuid() == 0:
                foreign = base / "foreign-owned"
                foreign.mkdir(mode=0o700)
                os.chown(foreign, 65534, 65534)
                policy = foreign / "broker-policy.json"
            else:
                policy = base / "broker-policy.json"
            policy.write_text(json.dumps({"schemaVersion": 1, "authorizedSha": "a" * 40,
                                          "enabledOperations": ["prepare"]}))
            os.chmod(policy, 0o600)
            with self.assertRaisesRegex(RuntimeError, "UNTRUSTED_DIRECTORY"):
                cas.inspect(policy)

    def test_parent_path_swap_after_open_is_confined_by_directory_fd(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            parent = root / "policy-dir"
            moved = root / "policy-dir-moved"
            attacker = root / "attacker-dir"
            parent.mkdir(mode=0o700)
            attacker.mkdir(mode=0o700)
            policy = parent / "broker-policy.json"
            lock = parent / "broker.lock"
            policy.write_text(json.dumps({"schemaVersion": 1, "authorizedSha": "a" * 40,
                                          "enabledOperations": ["prepare"]}))
            os.chmod(policy, 0o600)
            expected = test_inspect(policy)["generation"]
            original_write = cas._write_atomic_at
            swapped = []

            def swap_parent_then_write(directory_fd, target_name, encoded):
                parent.rename(moved)
                parent.symlink_to(attacker, target_is_directory=True)
                swapped.append(True)
                try:
                    original_write(directory_fd, target_name, encoded)
                finally:
                    parent.unlink()
                    moved.rename(parent)

            with patch.object(cas, "_write_atomic_at", side_effect=swap_parent_then_write):
                result = test_replace_if_generation(
                    policy, lock, expected, "dirfd-test", 60,
                    {"schemaVersion": 1, "authorizedSha": "b" * 40,
                     "enabledOperations": ["prepare"]}, now=100)

            self.assertTrue(swapped)
            self.assertEqual(test_inspect(policy)["generation"], result["generation"])
            self.assertEqual(test_inspect(policy)["policy"]["authorizedSha"], "b" * 40)
            self.assertFalse((attacker / "broker-policy.json").exists())
            self.assertEqual(list(attacker.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
