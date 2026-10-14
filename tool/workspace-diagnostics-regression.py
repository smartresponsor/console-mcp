import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('diagnostics', Path(__file__).resolve().parents[1] / 'ops/ubuntu/script/workspace-diagnostics.py')
diagnostics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostics)

class ClassificationTests(unittest.TestCase):
    def test_nested_mount_wins(self):
        mounts = '1 0 8:1 / /home rw - ext4 /dev/test rw\n2 1 8:1 / /home/alex/smartresponse rw - ext4 /dev/test rw\n3 2 8:1 / /home/alex/smartresponse/mcp ro - ext4 /dev/test rw\n'
        mount = diagnostics.mount_for(mounts, '/home/alex/smartresponse/mcp/console-mcp')
        self.assertEqual(mount['options'], ['ro'])
        self.assertEqual(diagnostics.classify_mount({'options':['rw']}, mount), 'WORKSPACE_MOUNT_CONFLICT')
        self.assertEqual(diagnostics.mount_for(mounts, '/home/alex/smartresponse/mcp-other')['options'], ['rw'])
    def test_read_only_host(self):
        self.assertEqual(diagnostics.classify_mount({'options':['ro']}, {'options':['ro']}), 'WORKSPACE_READ_ONLY')
    def test_missing_namespace(self):
        self.assertEqual(diagnostics.classify_mount({'options':['rw']}, None), 'WORKSPACE_DIAGNOSTICS_INCOMPLETE')
    def test_acl_permission(self):
        acl = 'user::rwx\ngroup::rwx\nother::r-x\n'
        self.assertFalse(diagnostics.acl_can_write(acl, 1000, 1000, 993, {988, 1001}))
        self.assertTrue(diagnostics.acl_can_write(acl, 1000, 1001, 993, {988, 1001}))
        named = acl + 'user:993:rwx #effective:r-x\nmask::r-x\n'
        self.assertFalse(diagnostics.acl_can_write(named, 1000, 1000, 993, {988, 1001}))
        self.assertIsNone(diagnostics.acl_can_write('', 1000, 1000, 993, {988}))
    def test_git_failure(self):
        self.assertEqual(diagnostics.git_classification({'ok':False, 'stderr':'fatal: detected dubious ownership'}), 'GIT_OWNERSHIP_UNSAFE')
        self.assertEqual(diagnostics.git_classification({'ok':False, 'stderr':'sudo: a password is required'}), 'GIT_STATUS_UNAVAILABLE')

unittest.main()
