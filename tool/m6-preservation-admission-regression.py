import hashlib
import importlib.util
import json
import pathlib
import stat
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parent.parent
def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

a = load('admission', 'ops/ubuntu/deployment/preservation-admission.py')
d = load('deploy', 'ops/ubuntu/deployment/deploy.py')

class Admission(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tree = pathlib.Path(self.tmp.name)
        self.marker = self.tree / 'dist/engine/preservation-baseline.js'
        self.marker.parent.mkdir(parents=True)
        self.marker.write_text('fixture')
        self.manifest = {n: hashlib.sha256(n.encode()).hexdigest() for n in a.FILES}
        self.cfg = dict(source=str(a.BUNDLE/'collector_windows.py'), sha256=self.manifest['collector_windows.py'],
                        root=a.ROOT, repositories={'console':a.LIVE}, store='/private-fixture',
                        allowed_uids=[993], socket=a.SOCKET,
                        bundle_sha256=a.sha(json.dumps({n:self.manifest[n] for n in a.FILES-{'preservation_bundle.py'}},sort_keys=True,separators=(',',':')).encode('ascii')))
        self.blobs = {self.tree/'tool/m5-manifest.json': json.dumps(self.manifest).encode(),
                      a.BUNDLE/'manifest.json':json.dumps({n:self.manifest[n+'.py'] for n in a.NAMES}).encode()}
        for n in a.FILES:
            self.blobs[self.tree/'tool'/n] = n.encode()
            self.blobs[a.BUNDLE/n] = n.encode()
        self.real_stat = a.os.stat
        self.stats = {
            '/private-fixture': self.st(stat.S_IFDIR|0o700,1000,1001),
            str(pathlib.Path(a.SOCKET).parent):self.st(stat.S_IFDIR|0o710,1000,1001),
            a.SOCKET:self.st(stat.S_IFSOCK|0o660,1000,1001),
        }
    def st(self, mode, uid, gid):
        return types.SimpleNamespace(st_mode=mode,st_uid=uid,st_gid=gid)
    def read(self,path):
        if path==a.CONFIG:return json.dumps(self.cfg).encode()
        if path not in self.blobs:raise FileNotFoundError(str(path))
        return self.blobs[path]
    def fake_stat(self,path,*args,**kwargs):
        if str(path) in self.stats:return self.stats[str(path)]
        return self.real_stat(path,*args,**kwargs)
    def execute(self, result=None):
        if result is None:result=types.SimpleNamespace(returncode=0,stdout='PRESERVATION_ENGINE_PROBE_PASS\n')
        with patch.object(a,'trusted',side_effect=self.read), patch.object(a.os,'stat',side_effect=self.fake_stat), \
             patch.object(a.os.path,'realpath',side_effect=lambda p:str(p)), patch.object(a.os.path,'isdir',return_value=True), \
             patch.object(a.pwd,'getpwnam',side_effect=lambda n:types.SimpleNamespace(pw_uid=993 if n=='console-mcp' else 1000,pw_gid=988,pw_dir='/var/lib/console-mcp')), \
             patch.object(a.grp,'getgrnam',return_value=types.SimpleNamespace(gr_gid=1001)), \
             patch.object(a.subprocess,'run',return_value=result) as run:
            socket=a.admission(self.tree)
            if socket:
                self.assertEqual(run.call_args.kwargs['user'],993)
                self.assertEqual(run.call_args.kwargs['extra_groups'],[1001])
                self.assertEqual(run.call_args.kwargs['env']['CONSOLE_MCP_PRESERVATION_SOCKET'],a.SOCKET)
                self.assertEqual(run.call_args.kwargs['env']['CONSOLE_MCP_PRESERVATION_BUNDLE_SHA256'],self.cfg['bundle_sha256'])
                self.assertEqual(run.call_args.kwargs['env']['CONSOLE_MCP_PRESERVATION_CONFIG_SHA256'],a.sha(json.dumps(self.cfg).encode()))
                self.assertIn(str(self.marker),run.call_args.args[0])
            return socket
    def test_admission(self):
        binding=self.execute()
        self.assertEqual(binding,(a.SOCKET,self.cfg['bundle_sha256'],a.sha(json.dumps(self.cfg).encode())))
    def test_legacy_and_rollback(self):
        with self.assertRaisesRegex(RuntimeError,'PRESERVATION_ADMISSION_REQUIRED'):
            d.override(self.tree)
        binding=self.execute()
        rendered=d.override(self.tree,binding)
        self.assertIn(('Environment=CONSOLE_MCP_PRESERVATION_SOCKET='+a.SOCKET).encode(),rendered)
        self.assertIn(('Environment=CONSOLE_MCP_PRESERVATION_BUNDLE_SHA256='+binding[1]).encode(),rendered)
        self.assertIn(('Environment=CONSOLE_MCP_PRESERVATION_CONFIG_SHA256='+binding[2]).encode(),rendered)
        self.marker.unlink()
        self.assertIsNone(self.execute())
        self.assertIn(b'UnsetEnvironment=CONSOLE_MCP_PRESERVATION_SOCKET',d.override(self.tree))
        with self.assertRaisesRegex(RuntimeError,'PRESERVATION_ROLLBACK_BINDING'):
            d.override(self.tree,a.SOCKET)
    def test_cutover_guard_before_side_effects(self):
        old = self.tree / 'rollback'
        old.mkdir()
        reg = {'sourceSHA':'a'*40}
        with patch.object(d,'release',side_effect=[self.tree,old]), patch.object(d,'verify',return_value={'sourceCommit':'a'*40}), patch.object(d,'preservation_admission') as admission, patch.object(d,'atomic') as atomic, patch.object(d,'restart') as restart:
            with self.assertRaisesRegex(RuntimeError,'PRESERVATION_CUTOVER_NOT_ADMITTED'):
                d.apply(reg)
            admission.assert_not_called();atomic.assert_not_called();restart.assert_not_called()
    def test_loaded_bytes_attestation(self):
        bootstrap=load('m6_bootstrap','tool/preservation_bundle.py')
        tool=ROOT/'tool'
        manifest=json.loads((tool/'m5-manifest.json').read_bytes())
        import os
        fd=os.open(tool,os.O_DIRECTORY|os.O_NOFOLLOW)
        try:
            # Workspace files are not immutable root-owned installation artifacts.
            # Exercise the same load() logic using the exact manifest-checked bytes.
            verified={}
            for name in bootstrap.NAMES:
                raw=(tool/(name+'.py')).read_bytes()
                self.assertEqual(a.sha(raw),manifest[name+'.py'])
                verified[name]=raw
        finally:os.close(fd)
        server=bootstrap.load(verified)
        collector=manifest['collector_windows.py']
        expected=a.sha(json.dumps({n:manifest[n] for n in a.FILES-{'preservation_bundle.py'}},sort_keys=True,separators=(',',':')).encode('ascii'))
        cfg={'sha256':collector,'bundle_sha256':expected}
        raw=json.dumps(cfg).encode()
        broker=types.SimpleNamespace(digest=collector)
        server.bind_loaded(broker,cfg,raw)
        self.assertEqual(broker.attestation,{'bundleSha256':expected,'configSha256':a.sha(raw)})
        # Loading different valid Python bytes changes the measured identity even
        # when the externally supplied expected digest remains unchanged.
        verified['preservation_server_v3']+=b'\n# stale loaded generation\n'
        stale=bootstrap.load(verified)
        with self.assertRaisesRegex(ValueError,'PRESERVATION_BUNDLE_IDENTITY'):
            stale.bind_loaded(types.SimpleNamespace(digest=collector),cfg,raw)
    def test_loaded_bundle_config_binding(self):
        self.cfg['bundle_sha256']='0'*64
        with self.assertRaisesRegex(ValueError,'PRESERVATION_CONFIG_BINDING'):
            self.execute()
    def test_bundle_mismatch(self):
        self.blobs[a.BUNDLE/'preservation_identity.py']=b'drift'
        with self.assertRaisesRegex(ValueError,'PRESERVATION_BUNDLE_MISMATCH'):
            self.execute()
    def test_missing_bundle(self):
        del self.blobs[a.BUNDLE/'manifest.json']
        with self.assertRaises(FileNotFoundError):
            self.execute()
    def test_registry_and_uid(self):
        self.cfg['allowed_uids']=[993,1000]
        with self.assertRaisesRegex(ValueError,'PRESERVATION_CONFIG_BINDING'):
            self.execute()
        self.cfg['allowed_uids']=[993];self.cfg['repositories']={'other':a.ROOT+'/other'}
        with self.assertRaisesRegex(ValueError,'PRESERVATION_REGISTRY_COVERAGE'):
            self.execute()
    def test_socket_and_store(self):
        self.stats[a.SOCKET]=self.st(stat.S_IFSOCK|0o666,1000,1001)
        with self.assertRaisesRegex(PermissionError,'PRESERVATION_SOCKET'):
            self.execute()
        self.stats[a.SOCKET]=self.st(stat.S_IFSOCK|0o660,1000,1001)
        self.stats['/private-fixture']=self.st(stat.S_IFDIR|0o770,1000,1001)
        with self.assertRaisesRegex(PermissionError,'PRESERVATION_STORE'):
            self.execute()
    def test_probe_failure(self):
        with self.assertRaisesRegex(RuntimeError,'PRESERVATION_ENGINE_PROBE_FAILED'):
            self.execute(types.SimpleNamespace(returncode=1,stdout=''))
        with self.assertRaisesRegex(RuntimeError,'PRESERVATION_ENGINE_PROBE_FAILED'):
            self.execute(types.SimpleNamespace(returncode=0,stdout='wrong'))
    def test_duplicate_and_untrusted_path(self):
        with self.assertRaisesRegex(ValueError,'PRESERVATION_DUPLICATE_KEY'):
            json.loads('{"a":1,"a":2}',object_pairs_hook=a.unique)
        p=self.tree/'unsafe';p.write_text('fixture')
        with self.assertRaises(PermissionError):
            a.trusted(p)

if __name__=='__main__':
    unittest.main()
