#!/usr/bin/env python3
import importlib.util
import os
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("preflight", "ops/ubuntu/script/ownership-preflight.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class PreflightTests(unittest.TestCase):
    def test_regular_and_idempotent(self):
        with tempfile.TemporaryDirectory(prefix="eng16-", dir="/tmp") as root:
            pathlib.Path(root, "dir").mkdir()
            pathlib.Path(root, "dir", "file").write_text("data")
            self.assertEqual(mod.inspect(root), 2)
            self.assertEqual(mod.inspect(root), 2)

    def test_symlink_escape(self):
        with tempfile.TemporaryDirectory(prefix="eng16-", dir="/tmp") as root:
            os.symlink("/etc", pathlib.Path(root, "escape"))
            with self.assertRaises(mod.UnsafePath):
                mod.inspect(root)

    def test_symlink_root(self):
        with tempfile.TemporaryDirectory(prefix="eng16-", dir="/tmp") as root:
            os.symlink(root, root + "-link")
            try:
                with self.assertRaises(OSError):
                    mod.inspect(root + "-link")
            finally:
                os.unlink(root + "-link")

    def test_special_file(self):
        with tempfile.TemporaryDirectory(prefix="eng16-", dir="/tmp") as root:
            os.mkfifo(pathlib.Path(root, "fifo"))
            with self.assertRaises(mod.UnsafePath):
                mod.inspect(root)

    def test_mount_boundary_rejected(self):
        with tempfile.TemporaryDirectory(prefix="eng16-", dir="/tmp") as root:
            original = mod.os.stat
            def injected(name, *args, **kwargs):
                info = original(name, *args, **kwargs)
                if name == "file":
                    class FakeStat:
                        st_dev = info.st_dev + 1
                        st_ino = info.st_ino
                        st_mode = info.st_mode
                    return FakeStat()
                return info
            pathlib.Path(root, "file").write_text("x")
            mod.os.stat = injected
            try:
                with self.assertRaisesRegex(mod.UnsafePath, "mount boundary"):
                    mod.inspect(root)
            finally:
                mod.os.stat = original

    def test_entry_limit(self):
        with tempfile.TemporaryDirectory(prefix="eng16-", dir="/tmp") as root:
            pathlib.Path(root, "a").touch()
            pathlib.Path(root, "b").touch()
            with self.assertRaisesRegex(mod.UnsafePath, "entry limit"):
                mod.inspect(root, max_entries=1)

if __name__ == "__main__":
    unittest.main(verbosity=2)
