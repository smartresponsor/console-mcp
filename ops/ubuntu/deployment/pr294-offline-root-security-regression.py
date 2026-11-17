#!/usr/bin/python3
"""Unprivileged security regression for PR294 offline root runner."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase, main, mock
import stat

source = Path(__file__).with_name("pr294-offline-root-acceptance.py")
spec = importlib.util.spec_from_file_location("pr294_root_runner", source)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RunnerSecurityTest(TestCase):
    def test_nonroot_fail_closed(self):
        with mock.patch.object(runner.os, "geteuid", return_value=1000):
            with self.assertRaisesRegex(SystemExit, "ROOT_REQUIRED"):
                runner.main()

    def test_rejects_writable_ancestor(self):
        def metadata(path):
            return SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | (0o777 if str(path) == "/opt" else 0o755))
        with mock.patch.object(Path, "lstat", autospec=True, side_effect=metadata):
            with self.assertRaisesRegex(SystemExit, "UNTRUSTED_PATH:/opt"):
                runner.trusted_path(Path("/opt/pr294-offline-test/source"), directory=True)

    def test_rejects_symlink_ancestor(self):
        def metadata(path):
            return SimpleNamespace(st_uid=0, st_mode=(stat.S_IFLNK if str(path) == "/opt" else stat.S_IFDIR) | 0o755)
        with mock.patch.object(Path, "lstat", autospec=True, side_effect=metadata):
            with self.assertRaisesRegex(SystemExit, "UNTRUSTED_PATH:/opt"):
                runner.trusted_path(Path("/opt/pr294-offline-test/source"), directory=True)

    def test_rejects_nonroot_owner(self):
        def metadata(path):
            return SimpleNamespace(st_uid=1000 if str(path) == "/opt" else 0, st_mode=stat.S_IFDIR | 0o755)
        with mock.patch.object(Path, "lstat", autospec=True, side_effect=metadata):
            with self.assertRaisesRegex(SystemExit, "UNTRUSTED_PATH:/opt"):
                runner.trusted_path(Path("/opt/pr294-offline-test/source"), directory=True)

    def test_rejects_untrusted_file_type(self):
        with mock.patch.object(Path, "lstat", return_value=SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | 0o755)):
            with mock.patch.object(Path, "stat", return_value=SimpleNamespace(st_mode=stat.S_IFDIR | 0o755)):
                with self.assertRaisesRegex(SystemExit, "NOT_REGULAR_FILE"):
                    runner.trusted_path(Path("/opt/pr294-offline-test/expected-sha"))

    def test_runner_rejects_skipped_tests_even_with_zero_exit(self):
        fake = SimpleNamespace(returncode=0, stdout="", stderr="Ran 8 tests in 0.01s\\n\\nOK (skipped=5)\\n")
        with mock.patch.object(runner.os, "geteuid", return_value=0), \
             mock.patch.object(runner, "trusted_path"), \
             mock.patch.object(Path, "read_text", return_value="a" * 40), \
             mock.patch.object(runner.subprocess, "check_output", side_effect=["a" * 40, ""]), \
             mock.patch.object(runner.subprocess, "run", return_value=fake):
            with self.assertRaisesRegex(SystemExit, "TEST_FAILED_OR_SKIPPED"):
                runner.main()

    def test_runner_accepts_only_positive_unittest_summary(self):
        fake = SimpleNamespace(returncode=0, stdout="", stderr="Ran 8 tests in 0.01s\\n\\nOK\\n")
        with mock.patch.object(runner.os, "geteuid", return_value=0), \
             mock.patch.object(runner, "trusted_path"), \
             mock.patch.object(Path, "read_text", return_value="a" * 40), \
             mock.patch.object(runner.subprocess, "check_output", side_effect=["a" * 40, ""]), \
             mock.patch.object(runner.subprocess, "run", return_value=fake) as run:
            runner.main()
            self.assertEqual(run.call_count, len(runner.TESTS))


if __name__ == "__main__":
    main()
