#!/usr/bin/env python3
"""Real two-target ACL/default-ACL, rollback and SIGKILL integration tests."""
import importlib.util
import os
import pathlib
import shutil
import signal
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("eng16_multi", "ops/ubuntu/script/ownership-transaction.py")
mt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mt)

def acl(path):
    return subprocess.run(["getfacl", "-cp", str(path)], check=True, text=True, capture_output=True).stdout

def tree_metadata(root):
    result = {}
    for base, dirs, files in os.walk(root, followlinks=False):
        dirs.sort(); files.sort()
        for name in ["."] + dirs + files:
            p = pathlib.Path(base) if name == "." else pathlib.Path(base, name)
            st = p.lstat()
            result[str(p.relative_to(root))] = (st.st_uid, st.st_gid, st.st_mode & 0o7777)
    return result

def tree_acl(root):
    result = {}
    for base, dirs, files in os.walk(root, followlinks=False):
        dirs.sort(); files.sort()
        for name in ["."] + dirs + files:
            p = pathlib.Path(base) if name == "." else pathlib.Path(base, name)
            result[str(p.relative_to(root))] = acl(p)
    return result

class MultiTargetAclTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("getfacl") and shutil.which("setfacl"), "ACL tools unavailable")
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="eng16-multi-", dir="/tmp")
        self.addCleanup(self.tmp.cleanup)
        self.base = pathlib.Path(self.tmp.name)
        # Numeric ACL qualifiers avoid assuming workstation-specific passwd entries.
        mt.ACL_PRINCIPALS = (str(500000 + os.getuid()), str(600000 + os.getuid()))
        self.targets = [str(self.base / "workspaces"), str(self.base / "dist")]
        for target in self.targets:
            root = pathlib.Path(target)
            (root / "nested").mkdir(parents=True)
            (root / "nested" / "artifact.txt").write_text("fixture")
            (root / "nested" / "another.txt").write_text("sibling")
            (root / "z-dir").mkdir()
            (root / "top.txt").write_text("top-level")
        self.journal = str(self.base / "journal.json")

    def test_real_multi_target_default_acl_nested_and_idempotency(self):
        before = [tree_acl(pathlib.Path(p)) for p in self.targets]
        mt.apply_targets(self.targets, self.journal)
        self.assertFalse(os.path.exists(self.journal))
        for target in self.targets:
            root = pathlib.Path(target)
            root_acl = acl(root)
            nested_acl = acl(root / "nested")
            self.assertIn(f"default:user:{mt.ACL_PRINCIPALS[0]}:rwx", root_acl)
            self.assertIn(f"default:user:{mt.ACL_PRINCIPALS[1]}:rwx", root_acl)
            self.assertIn(f"default:user:{mt.ACL_PRINCIPALS[0]}:rwx", nested_acl)
            new_file = root / "nested" / "inherited.txt"
            new_file.write_text("inherited")
            inherited = acl(new_file)
            self.assertIn(f"user:{mt.ACL_PRINCIPALS[0]}:", inherited)
            self.assertIn(f"user:{mt.ACL_PRINCIPALS[1]}:", inherited)
        mt.apply_targets(self.targets, self.journal)
        self.assertFalse(os.path.exists(self.journal))

    def test_multi_target_failure_rolls_back_both_targets(self):
        before = [tree_acl(pathlib.Path(p)) for p in self.targets]
        metadata_before = [tree_metadata(pathlib.Path(p)) for p in self.targets]
        with self.assertRaisesRegex(mt.Denied, "injected multi-target failure"):
            mt.apply_targets(self.targets, self.journal, inject_after=7)
        after = [tree_acl(pathlib.Path(p)) for p in self.targets]
        self.assertEqual(before, after)
        self.assertEqual(metadata_before, [tree_metadata(pathlib.Path(p)) for p in self.targets])
        self.assertFalse(os.path.exists(self.journal))

    def test_sigkill_after_first_target_acl_mutation_then_recover_both(self):
        before = [tree_acl(pathlib.Path(p)) for p in self.targets]
        pid = os.fork()
        if pid == 0:
            original = mt.mutate_acl
            calls = {"n": 0}
            def kill_after_first(fd, is_dir):
                original(fd, is_dir)
                calls["n"] += 1
                if calls["n"] == 7:
                    os.kill(os.getpid(), signal.SIGKILL)
            mt.mutate_acl = kill_after_first
            mt.apply_targets(self.targets, self.journal)
            os._exit(88)
        _, status = os.waitpid(pid, 0)
        self.assertTrue(os.WIFSIGNALED(status))
        self.assertEqual(os.WTERMSIG(status), signal.SIGKILL)
        self.assertTrue(os.path.isfile(self.journal))
        changed = [tree_acl(pathlib.Path(p)) for p in self.targets]
        self.assertNotEqual(changed[0], before[0], "first target must have been mutated before kill")
        self.assertNotEqual(changed[1], before[1], "second target must have been mutated before kill")
        mt.recover_targets(self.targets, self.journal)
        self.assertEqual([tree_acl(pathlib.Path(p)) for p in self.targets], before)
        self.assertFalse(os.path.exists(self.journal))

    def test_symlink_in_second_target_rejected_before_mutation(self):
        before = [tree_acl(pathlib.Path(p)) for p in self.targets]
        os.symlink("/etc/passwd", pathlib.Path(self.targets[1]) / "escape")
        with self.assertRaisesRegex(mt.Denied, "symlink|special file|mount boundary|race"):
            mt.apply_targets(self.targets, self.journal)
        os.unlink(pathlib.Path(self.targets[1]) / "escape")
        self.assertEqual([tree_acl(pathlib.Path(p)) for p in self.targets], before)
        self.assertFalse(os.path.exists(self.journal))

    def test_recovery_cleans_safe_orphan_journal_temp_without_journal(self):
        fd = os.open(self.journal + ".new", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.write(fd, b'{"incomplete":')
        os.fsync(fd)
        os.close(fd)
        mt.recover_targets(self.targets, self.journal)
        self.assertFalse(os.path.exists(self.journal + ".new"))
        self.assertFalse(os.path.exists(self.journal))

    def test_concurrent_new_entry_keeps_journal_for_manual_reconciliation(self):
        before = [tree_acl(pathlib.Path(p)) for p in self.targets]
        new_path = pathlib.Path(self.targets[0]) / "concurrent-created.txt"
        original_mutate = mt.mutate_acl
        calls = {"n": 0}
        def create_after_first_mutation(fd, is_dir):
            original_mutate(fd, is_dir)
            calls["n"] += 1
            if calls["n"] == 1:
                new_path.write_text("concurrent")
        mt.mutate_acl = create_after_first_mutation
        try:
            with self.assertRaisesRegex(mt.Denied, "tree entries/metadata changed"):
                mt.apply_targets(self.targets, self.journal)
        finally:
            mt.mutate_acl = original_mutate
        self.assertTrue(os.path.isfile(self.journal))
        new_path.unlink()
        mt.recover_targets(self.targets, self.journal)
        self.assertEqual([tree_acl(pathlib.Path(p)) for p in self.targets], before)
        self.assertFalse(os.path.exists(self.journal))

    def test_hardlink_to_outside_target_rejected_before_mutation(self):
        outside = self.base / "outside-alias.txt"
        inside = pathlib.Path(self.targets[0]) / "nested" / "hardlinked.txt"
        inside.write_text("shared inode")
        os.link(inside, outside)
        before = [tree_acl(pathlib.Path(p)) for p in self.targets]
        with self.assertRaisesRegex(mt.Denied, "hard-linked"):
            mt.apply_targets(self.targets, self.journal)
        self.assertEqual([tree_acl(pathlib.Path(p)) for p in self.targets], before)
        self.assertFalse(os.path.exists(self.journal))

    def test_journal_symlink_rejected(self):
        os.symlink("/etc/passwd", self.journal)
        with self.assertRaisesRegex(mt.Denied, "pending journal"):
            mt.apply_targets(self.targets, self.journal)
        self.assertTrue(os.path.islink(self.journal))

    def test_nested_symlink_swap_after_snapshot_keeps_journal_until_recovery(self):
        before = [tree_acl(pathlib.Path(p)) for p in self.targets]
        nested = pathlib.Path(self.targets[0]) / "nested"
        moved = pathlib.Path(self.targets[0]) / "nested.saved"
        original_mutate = mt.mutate_acl
        calls = {"n": 0}
        def swap_after_first_mutation(fd, is_dir):
            original_mutate(fd, is_dir)
            calls["n"] += 1
            if calls["n"] == 1:
                os.rename(nested, moved)
                os.symlink("/etc", nested)
        mt.mutate_acl = swap_after_first_mutation
        try:
            with self.assertRaisesRegex(mt.Denied, "recovery|symlink|ancestor|target root"):
                mt.apply_targets(self.targets, self.journal)
        finally:
            mt.mutate_acl = original_mutate
        self.assertTrue(os.path.isfile(self.journal))
        self.assertTrue(nested.is_symlink())
        os.unlink(nested)
        os.rename(moved, nested)
        mt.recover_targets(self.targets, self.journal)
        self.assertEqual([tree_acl(pathlib.Path(p)) for p in self.targets], before)
        self.assertFalse(os.path.exists(self.journal))

    def test_fifo_substitution_after_stat_does_not_block(self):
        target = pathlib.Path(self.targets[0])
        regular = target / "fifo-race"
        regular.write_text("fixture")
        root_fd = os.open(target, os.O_RDONLY | os.O_DIRECTORY)
        try:
            before = regular.lstat()
            regular.unlink()
            os.mkfifo(regular)
            def alarm_handler(*args):
                raise AssertionError("blocking FIFO open")
            previous = signal.signal(signal.SIGALRM, alarm_handler)
            signal.alarm(2)
            try:
                with self.assertRaisesRegex(mt.Denied, "inode changed|special file"):
                    mt.open_child(root_fd, regular.name, before, target.stat().st_dev)
            finally:
                signal.alarm(0)
                signal.signal(signal.SIGALRM, previous)
        finally:
            os.close(root_fd)

    def test_unattempted_acl_change_is_not_rolled_back(self):
        victim = pathlib.Path(self.targets[1]) / "top.txt"
        # Explicit fixture precondition, independent of inherited process umask.
        subprocess.run(["setfacl", "-m", "g::r--", str(victim)], check=True)
        original_acl = acl(victim)
        self.assertIn("group::r--", original_acl)
        original_mutate = mt.mutate_acl
        calls = 0
        restriction = None
        def change_untouched(fd, is_dir):
            nonlocal calls, restriction
            original_mutate(fd, is_dir)
            calls += 1
            if calls == 1:
                subprocess.run(["setfacl", "-m", "g::---", str(victim)], check=True)
                restriction = acl(victim)
        mt.mutate_acl = change_untouched
        try:
            with self.assertRaisesRegex(mt.Denied, "untouched or restored ACL"):
                mt.apply_targets(self.targets, self.journal)
        finally:
            mt.mutate_acl = original_mutate
        self.assertIsNotNone(restriction)
        self.assertNotEqual(original_acl, restriction)
        self.assertEqual(acl(victim), restriction)
        self.assertTrue(os.path.isfile(self.journal))
        with self.assertRaisesRegex(mt.Denied, "untouched or restored ACL"):
            mt.recover_targets(self.targets, self.journal)
        self.assertEqual(acl(victim), restriction)
        self.assertTrue(os.path.isfile(self.journal))
        subprocess.run(["setfacl", "--set-file=-", str(victim)], input=original_acl, text=True, check=True)
        mt.recover_targets(self.targets, self.journal)
        self.assertFalse(os.path.exists(self.journal))

    def test_crash_intent_does_not_restore_unattempted_acl(self):
        victim = pathlib.Path(self.targets[1]) / "top.txt"
        # Explicit fixture precondition, independent of inherited process umask.
        subprocess.run(["setfacl", "-m", "g::r--", str(victim)], check=True)
        original_acl = acl(victim)
        self.assertIn("group::r--", original_acl)
        pid = os.fork()
        if pid == 0:
            original = mt.mutate_acl
            def kill_after_mutation(fd, is_dir):
                original(fd, is_dir)
                os.kill(os.getpid(), signal.SIGKILL)
            mt.mutate_acl = kill_after_mutation
            mt.apply_targets(self.targets, self.journal)
            os._exit(88)
        _, status = os.waitpid(pid, 0)
        self.assertTrue(os.WIFSIGNALED(status))
        self.assertEqual(os.WTERMSIG(status), signal.SIGKILL)
        import json
        record = json.loads(pathlib.Path(self.journal).read_text())
        self.assertEqual(record["version"], 2)
        self.assertEqual(record["attemptedCount"], 1)
        subprocess.run(["setfacl", "-m", "g::---", str(victim)], check=True)
        restriction = acl(victim)
        self.assertNotEqual(original_acl, restriction)
        with self.assertRaisesRegex(mt.Denied, "untouched or restored ACL"):
            mt.recover_targets(self.targets, self.journal)
        self.assertEqual(acl(victim), restriction)
        self.assertTrue(os.path.isfile(self.journal))
        subprocess.run(["setfacl", "--set-file=-", str(victim)], input=original_acl, text=True, check=True)
        mt.recover_targets(self.targets, self.journal)
        self.assertFalse(os.path.exists(self.journal))

    def test_legacy_journal_without_intents_requires_manual_review(self):
        import json
        record = {"version": 1, "state": "prepared", "targets": []}
        fd = os.open(self.journal, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(record, f)
        before = [tree_acl(pathlib.Path(p)) for p in self.targets]
        with self.assertRaisesRegex(mt.Denied, "manual review"):
            mt.recover_targets(self.targets, self.journal)
        self.assertTrue(os.path.isfile(self.journal))
        self.assertEqual(before, [tree_acl(pathlib.Path(p)) for p in self.targets])

    def test_rollback_failure_keeps_combined_journal(self):
        before = [tree_acl(pathlib.Path(p)) for p in self.targets]
        original = mt.restore_open_snapshot
        original_mutate = mt.mutate_acl
        def fail_restore(*args, **kwargs):
            raise mt.Denied("injected rollback failure")
        mt.mutate_acl = lambda fd, is_dir: subprocess.run(
            ["setfacl", "-m", f"u:{mt.ACL_PRINCIPALS[0]}:rwX,u:{mt.ACL_PRINCIPALS[1]}:rwX,m:rwX", f"/proc/self/fd/{fd}"],
            pass_fds=(fd,), check=True, capture_output=True)
        mt.restore_open_snapshot = fail_restore
        try:
            with self.assertRaisesRegex(mt.Denied, "injected rollback failure"):
                mt.apply_targets(self.targets, self.journal, inject_after=1)
            self.assertTrue(os.path.isfile(self.journal))
        finally:
            mt.restore_open_snapshot = original
            mt.mutate_acl = original_mutate
        temp_fd = os.open(self.journal + ".new", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.write(temp_fd, b'{"stale":true}')
        os.fsync(temp_fd)
        os.close(temp_fd)
        mt.recover_targets(self.targets, self.journal)
        self.assertFalse(os.path.exists(self.journal + ".new"))
        self.assertEqual([tree_acl(pathlib.Path(p)) for p in self.targets], before)

if __name__ == "__main__":
    unittest.main(verbosity=2)
