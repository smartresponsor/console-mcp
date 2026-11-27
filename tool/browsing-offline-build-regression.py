#!/usr/bin/python3
import hashlib,json,os,runpy,tempfile,unittest
from pathlib import Path
M=runpy.run_path(str(Path(__file__).resolve().parents[1]/'ops/ubuntu/deployment/browsing-offline-build.py'))
H=lambda b:hashlib.sha256(b).hexdigest()
S='a'*40
class InputTest(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory();self.root=Path(self.t.name)
  self.cap=self.root/'capsule';self.run=self.root/'run'
  self.cap.mkdir(mode=0o700);self.run.mkdir(mode=0o700)
  self.cache=self.cap/'npm-cache'/'_cacache';self.cache.mkdir(parents=True,mode=0o700)
  for p in (self.cap/'npm-cache',self.cache):p.chmod(0o700)
  self.write(self.cache/'content',b'cache fixture')
  self.write(self.cap/'source.bundle',b'opaque bundle fixture')
  manifest=json.dumps({'_cacache/content':H(b'cache fixture')}).encode()
  self.write(self.cap/'npm-cache.json',manifest)
  self.m=dict(schemaVersion=1,sourceSHA=S,signerFingerprint=M['SIGNER'],sourceBundleSha256=H(b'opaque bundle fixture'),cacheManifestSha256=H(manifest),lockfiles={n:'b'*64 for n in M['LOCKS']})
  self.pin=self.manifest()
 def tearDown(self):self.t.cleanup()
 def write(self,p,b):p.write_bytes(b);p.chmod(0o600)
 def manifest(self):
  raw=json.dumps(self.m).encode();self.write(self.cap/'capsule.json',raw);return H(raw)
 def go(self):return M['import_capsule'](self.cap,self.run,S,self.pin,os.getuid())
 def test_import(self):
  self.assertEqual(self.go(),self.m)
  self.assertEqual((self.run/'artifact'/'source.bundle').read_bytes(),b'opaque bundle fixture')
  self.assertEqual((self.run/'cache-input'/'_cacache'/'content').read_bytes(),b'cache fixture')
 def test_bundle_drift(self):
  self.write(self.cap/'source.bundle',b'changed')
  with self.assertRaisesRegex(ValueError,'CONTENT_PIN'):self.go()
 def test_cache_drift(self):
  self.write(self.cache/'content',b'changed')
  with self.assertRaisesRegex(ValueError,'CACHE_PIN'):self.go()
 def test_cache_extra(self):
  self.write(self.cache/'extra',b'x')
  with self.assertRaisesRegex(ValueError,'CACHE_EXTRA'):self.go()
 def test_symlink(self):
  (self.cap/'source.bundle').unlink();(self.cap/'source.bundle').symlink_to(self.cache/'content')
  with self.assertRaises(OSError):self.go()
 def test_hardlink(self):
  os.link(self.cap/'source.bundle',self.root/'alias')
  with self.assertRaisesRegex(ValueError,'CAPSULE_MEMBER'):self.go()
 def test_wrong_sha(self):
  self.m['sourceSHA']='c'*40;self.pin=self.manifest()
  with self.assertRaisesRegex(ValueError,'CAPSULE_IDENTITY'):self.go()
 def test_wrong_signer(self):
  self.m['signerFingerprint']='wrong';self.pin=self.manifest()
  with self.assertRaisesRegex(ValueError,'CAPSULE_IDENTITY'):self.go()
 def test_group_write(self):
  (self.cap/'source.bundle').chmod(0o660)
  with self.assertRaisesRegex(ValueError,'CAPSULE_MEMBER'):self.go()
 def test_duplicate(self):
  raw=b'{"schemaVersion":1,"schemaVersion":1}'
  with self.assertRaisesRegex(ValueError,'DUPLICATE_KEY'):M['parse_capsule'](raw,S,H(raw))
 def test_embedded_program(self):
  compile(M['BUILD'],'browsing-build-isolated','exec')
  for flag in ('--offline','--ignore-scripts','--no-bin-links','verify-commit','os.getpid()==1'):
   self.assertIn(flag,M['BUILD'])
if __name__=='__main__':unittest.main(verbosity=2)
