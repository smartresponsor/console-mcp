#!/usr/bin/python3
"""Regression coverage for the isolated release-policy CAS primitive."""
import importlib.util
import json
import multiprocessing
import os
from pathlib import Path
import stat
import tempfile
import threading
import unittest


MODULE = Path(__file__).with_name("release-policy-cas.py")
spec = importlib.util.spec_from_file_location("release_policy_cas", MODULE)
cas = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cas)


def _process_cas_contender(policy_path, lock_path, expected, owner, start, results):
    start.wait(10)
    try:
        cas.replace_if_generation(Path(policy_path), Path(lock_path), expected, owner, 120,
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
    cas.replace_if_generation(Path(policy_path), Path(lock_path), expected, "crash-writer", 120,
                              {"schemaVersion": 1, "authorizedSha": "c" * 40,
                               "enabledOperations": ["prepare"]}, now=100)


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
            policy.write_text(json.dumps({"schemaVersion": 1, "authorizedSha": "a" * 40, "enabledOperations": ["prepare"]}))
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


    @unittest.skipUnless(os.geteuid() == 0, "root-only trusted-path regression")
    def test_root_owned_sticky_tmp_ancestor_is_accepted(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            os.chmod(base, 0o700)
            fd = cas._open_directory_chain(base)
            try:
                self.assertEqual(os.fstat(fd).st_uid, 0)
            finally:
                os.close(fd)

    @unittest.skipUnless(os.geteuid() == 0, "root-only trusted-path regression")
    def test_writable_nonsticky_ancestor_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            unsafe = Path(temp) / "unsafe"
            unsafe.mkdir()
            os.chmod(unsafe, 0o777)
            nested = unsafe / "nested"
            nested.mkdir()
            os.chmod(nested, 0o700)
            with self.assertRaisesRegex(RuntimeError, "UNTRUSTED_DIRECTORY"):
                cas._open_directory_chain(nested)

    @unittest.skipUnless(os.geteuid() == 0, "root-only trusted-path regression")
    def test_symlink_ancestor_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            real = base / "real"
            real.mkdir()
            os.chmod(real, 0o700)
            link = base / "link"
            link.symlink_to(real, target_is_directory=True)
            with self.assertRaises(OSError):
                cas._open_directory_chain(link)

    @unittest.skipUnless(os.geteuid() == 0, "root-only multi-process CAS regression")
    def test_independent_process_writers_only_one_generation_wins(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            os.chmod(base, 0o700)
            policy = base / "broker-policy.json"
            lock = base / "broker.lock"
            policy.write_text(json.dumps({"schemaVersion": 1, "authorizedSha": "a" * 40,
                                          "enabledOperations": ["prepare"]}))
            os.chmod(policy, 0o600)
            expected = cas.inspect(policy)["generation"]
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
            self.assertEqual(cas.inspect(policy)["policy"]["authorizedSha"], "b" * 40)

    @unittest.skipUnless(os.geteuid() == 0, "root-only process-kill CAS regression")
    def test_process_kill_after_atomic_replace_leaves_complete_new_generation(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            os.chmod(base, 0o700)
            policy = base / "broker-policy.json"
            lock = base / "broker.lock"
            policy.write_text(json.dumps({"schemaVersion": 1, "authorizedSha": "a" * 40,
                                          "enabledOperations": ["prepare"]}))
            os.chmod(policy, 0o600)
            expected = cas.inspect(policy)["generation"]
            context = multiprocessing.get_context("fork")
            ready = context.Event()
            process = context.Process(target=_process_pause_after_atomic_replace,
                                      args=(str(policy), str(lock), expected, ready))
            process.start()
            self.assertTrue(ready.wait(15), "writer never reached post-rename directory fsync")
            process.terminate()
            process.join(10)
            self.assertFalse(process.is_alive())
            self.assertNotEqual(process.exitcode, 0)
            snapshot = cas.inspect(policy)
            self.assertEqual(snapshot["policy"]["authorizedSha"], "c" * 40)
            self.assertNotEqual(snapshot["generation"], expected)
            self.assertEqual(policy.stat().st_mode & 0o777, 0o600)


    @unittest.skipUnless(os.geteuid() == 0, "root-only CAS lock identity regression")
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
                cas.replace_if_generation(
                    policy, lock, cas.inspect(policy)["generation"], "release", 30,
                    {"schemaVersion": 1, "authorizedSha": "b" * 40,
                     "enabledOperations": ["prepare"]}, now=100)


if __name__ == "__main__":
    unittest.main()
