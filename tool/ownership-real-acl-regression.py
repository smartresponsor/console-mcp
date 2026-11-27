#!/usr/bin/env python3
"""Real ACL integration on isolated temporary directory; never invokes production apply."""
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

class RealAcl(unittest.TestCase):
    @unittest.skipUnless(shutil.which("getfacl") and shutil.which("setfacl"), "ACL binaries unavailable")
    def test_real_snapshot_restore(self):
        with tempfile.TemporaryDirectory(prefix="eng16-real-acl-", dir="/tmp") as root:
            target = pathlib.Path(root, "target")
            target.mkdir()
            original = subprocess.run(["getfacl", "-cp", str(target)], check=True, text=True, capture_output=True).stdout
            subprocess.run(["setfacl", "-m", "u::rwx,g::r-x,o::---", str(target)], check=True, capture_output=True)
            modified = subprocess.run(["getfacl", "-cp", str(target)], check=True, text=True, capture_output=True).stdout
            self.assertNotEqual(original, modified)
            subprocess.run(["setfacl", "--set-file=-", str(target)], input=original, text=True, check=True, capture_output=True)
            restored = subprocess.run(["getfacl", "-cp", str(target)], check=True, text=True, capture_output=True).stdout
            self.assertEqual(original, restored)

if __name__ == "__main__":
    unittest.main(verbosity=2)
