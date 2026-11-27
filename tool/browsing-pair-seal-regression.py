#!/usr/bin/python3
import hashlib,json,os,runpy,tempfile,unittest
from pathlib import Path
D=Path(__file__).resolve().parents[1]/'ops/ubuntu/deployment'
V=runpy.run_path(str(D/'browsing-pair-admission.py'))
S=runpy.run_path(str(D/'browsing-pair-seal.py'))
H=lambda b:hashlib.sha256(b).hexdigest()
C='a'*40
B='b'*40
U=os.getuid()
class Test(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.root=Path(self.tmp.name)
        self.store=self.root/'store';self.store.mkdir(mode=0o700)
        self.run=self.root/'m7-12345678';self.run.mkdir(mode=0o700)
        self.tree=self.run/'artifact'/'dist';self.tree.mkdir(parents=True)
        for p in (self.run/'artifact',self.tree):p.chmod(0o700)
        for n in (*V['LOCKFILES'],V['WORKER'],'.source-inventory.json','playwright-worker/node_modules/fixture/index.js'):
            self.write(self.tree/n,n.encode())
        self.files=V['inventory'](self.tree,U)
        self.ip=self.write(self.run/'browsing-inventory.json',self.raw(self.files))
        self.clean=dict(status='BROWSING_BUILD_CLEANUP_PASS',before={'pid':123},after={'pid':123},failures=[],errorType=None,activationEligible=False,cleanedUnits=['fixture'])
        self.kp=self.write(self.run/'cleanup.json',self.raw(self.clean))
        self.receipt=dict(status='BROWSING_LINUX_INDEPENDENT_BUILD_PASS',sourceSHA=B,runId=self.run.name,artifactPath=str(self.tree),inventorySha256=self.ip,cleanupSha256=self.kp,buildMode='offline-bwrap',lifecycleScripts=False,activationEligible=False,productionChanged=False,fileCount=len(self.files),lockfiles={n:self.files[n] for n in V['LOCKFILES']})
        self.rp=self.write(self.run/'browsing-receipt.json',self.raw(self.receipt))
        self.console,self.cp=self.make_console(C)
    def tearDown(self):self.tmp.cleanup()
    def raw(self,v):return (json.dumps(v,sort_keys=True)+'\n').encode()
    def write(self,p,raw):
        p.parent.mkdir(parents=True,exist_ok=True)
        q=p.parent
        while q!=self.root:q.chmod(0o700);q=q.parent
        p.write_bytes(raw);p.chmod(0o600)
        return H(raw)
    def make_console(self,sha):
        c=self.root/sha;c.mkdir(mode=0o700)
        for n in (V['LOCK'],V['SESSION'],'package-lock.json'):self.write(c/n,(sha+n).encode())
        f=V['inventory'](c,U)
        return c,self.write(c/'release.json',self.raw(dict(sourceCommit=sha,files=f,lockfileSha256=f['package-lock.json'])))
    def seal(self,c=None,sha=C,pin=None):
        return S['seal'](c or self.console,sha,pin or self.cp,self.run,B,self.rp,self.ip,self.kp,self.store,U,V)
    def test_seal_and_reuse(self):
        a=self.seal();self.assertFalse(a['reused']);self.assertFalse(a['activationEligible'])
        self.assertEqual(Path(a['releasePath']),self.store/C/B)
        self.assertEqual(V['inventory'](Path(a['releasePath']),U),self.files)
        b=self.seal();self.assertTrue(b['reused']);self.assertEqual(a['browsingManifestSha256'],b['browsingManifestSha256'])
    def test_new_console_preserves_old(self):
        a=self.seal();old=Path(a['releasePath'])/'release.json';before=old.read_bytes()
        c,p=self.make_console('c'*40);b=self.seal(c,'c'*40,p)
        self.assertNotEqual(a['releasePath'],b['releasePath']);self.assertEqual(old.read_bytes(),before)
        self.assertEqual(V['inventory'](Path(b['releasePath']),U),self.files)
    def test_artifact_drift(self):
        self.write(self.tree/V['WORKER'],b'drift')
        with self.assertRaisesRegex(ValueError,'SEAL_EVIDENCE_DRIFT'):self.seal()
        self.assertFalse((self.store/C).exists())
    def test_receipt_pin(self):
        self.rp='0'*64
        with self.assertRaisesRegex(ValueError,'SEAL_EVIDENCE_PIN'):self.seal()
    def test_cleanup_drift(self):
        self.clean['after']={'pid':321}
        self.kp=self.write(self.run/'cleanup.json',self.raw(self.clean))
        self.receipt['cleanupSha256']=self.kp
        self.rp=self.write(self.run/'browsing-receipt.json',self.raw(self.receipt))
        with self.assertRaisesRegex(ValueError,'SEAL_CLEANUP_IDENTITY'):self.seal()
    def test_manifest_pin(self):
        with self.assertRaisesRegex(ValueError,'PAIR_MANIFEST_PIN'):self.seal(pin='0'*64)
    def test_existing_pair_drift_never_overwritten(self):
        a=self.seal();p=Path(a['releasePath'])/V['WORKER'];self.write(p,b'drift')
        with self.assertRaisesRegex(ValueError,'PAIR_INVENTORY_DRIFT'):self.seal()
        self.assertEqual(p.read_bytes(),b'drift')
    def test_symlink_evidence(self):
        p=self.tree/V['WORKER'];p.unlink();p.symlink_to(self.tree/V['LOCKFILES'][0])
        with self.assertRaisesRegex(ValueError,'PAIR_LINK_DENIED'):self.seal()
    def test_manifest_in_evidence(self):
        self.write(self.tree/'release.json',b'{}')
        with self.assertRaisesRegex(ValueError,'SEAL_EVIDENCE_DRIFT'):self.seal()
if __name__=='__main__':unittest.main(verbosity=2)
