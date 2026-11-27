#!/usr/bin/python3
import hashlib,json,os,runpy,tempfile,unittest
from pathlib import Path
from unittest.mock import patch, Mock
import importlib.util
M=runpy.run_path(str(Path(__file__).resolve().parents[1]/'ops/ubuntu/deployment/browsing-pair-admission.py'))
C='a'*40
B='b'*40
H=lambda raw:hashlib.sha256(raw).hexdigest()
class PairTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.c=Path(self.tmp.name)/C;self.b=Path(self.tmp.name)/B
        for r in (self.c,self.b):r.mkdir(mode=0o700)
        for r,paths in ((self.c,(M['LOCK'],M['SESSION'],'package-lock.json')),(self.b,(M['WORKER'],*M['LOCKFILES']))):
            for p in paths:
                q=r/p;q.parent.mkdir(parents=True,exist_ok=True);q.write_text(p)
        # Restrict fixture modes even when the host tmp parent has a default ACL.
        for r in (self.c,self.b):
            for p in r.rglob('*'):p.chmod(0o700 if p.is_dir() else 0o600)
        self.cm={'sourceCommit':C,'files':M['inventory'](self.c,os.getuid())}
        self.cm['lockfileSha256']=self.cm['files']['package-lock.json']
        self.cp=self.write(self.c,self.cm)
        self.bm={'schemaVersion':2,'sourceCommit':B,'files':M['inventory'](self.b,os.getuid()),
                 'console':{'sourceCommit':C,'manifestSha256':self.cp,'leaseModuleSha256':self.cm['files'][M['LOCK']],'sessionModuleSha256':self.cm['files'][M['SESSION']]}}
        self.bm['lockfiles']={n:self.bm['files'][n] for n in M['LOCKFILES']}
        self.bp=self.write(self.b,self.bm)
    def tearDown(self):self.tmp.cleanup()
    def write(self,r,m):
        raw=json.dumps(m,sort_keys=True).encode();(r/'release.json').write_bytes(raw);(r/'release.json').chmod(0o600);return H(raw)
    def verify(self):return M['verify_pair'](self.c,self.b,C,B,self.cp,self.bp,os.getuid())
    def test_exact_pair(self):
        r=self.verify();self.assertEqual(r['status'],'BROWSING_PAIR_INVENTORY_PASS');self.assertFalse(r['activationEligible'])
    def test_worker_drift(self):
        (self.b/M['WORKER']).write_text('changed')
        with self.assertRaisesRegex(ValueError,'INVENTORY_DRIFT'):self.verify()
    def test_console_drift(self):
        (self.c/M['LOCK']).write_text('changed')
        with self.assertRaisesRegex(ValueError,'INVENTORY_DRIFT'):self.verify()
    def test_wrong_pair(self):
        self.bm['console']['sourceCommit']='c'*40;self.bp=self.write(self.b,self.bm)
        with self.assertRaisesRegex(ValueError,'CONSOLE_BINDING'):self.verify()
    def test_manifest_pin(self):
        self.bp='0'*64
        with self.assertRaisesRegex(ValueError,'MANIFEST_PIN'):self.verify()
    def test_extra_member(self):
        (self.b/'extra').write_text('extra');(self.b/'extra').chmod(0o600)
        with self.assertRaisesRegex(ValueError,'INVENTORY_DRIFT'):self.verify()
    def test_lockfile_pin(self):
        self.bm['lockfiles'][M['LOCKFILES'][0]]='0'*64;self.bp=self.write(self.b,self.bm)
        with self.assertRaisesRegex(ValueError,'BROWSING_LOCKFILES'):self.verify()
    def test_group_writable(self):
        (self.c/M['LOCK']).chmod(0o664)
        with self.assertRaisesRegex(ValueError,'UNPROTECTED'):self.verify()
    def test_hardlink(self):
        os.link(self.c/M['LOCK'],self.c/'duplicate')
        with self.assertRaisesRegex(ValueError,'MEMBER_TYPE'):self.verify()
    def test_escape(self):
        d=self.b/'node_modules';d.mkdir();d.chmod(0o700);(d/'outside').symlink_to(self.c/M['LOCK'])
        with self.assertRaisesRegex(ValueError,'LINK_ESCAPE'):self.verify()
    def test_missing_lease_module(self):
        (self.c/M['LOCK']).unlink();del self.cm['files'][M['LOCK']];self.cp=self.write(self.c,self.cm)
        with self.assertRaisesRegex(ValueError,'REQUIRED_MEMBER'):self.verify()
    def test_duplicate_json(self):
        raw=b'{"sourceCommit":"'+B.encode()+b'","sourceCommit":"'+B.encode()+b'"}'
        (self.b/'release.json').write_bytes(raw);self.bp=H(raw)
        with self.assertRaisesRegex(ValueError,'DUPLICATE_JSON_KEY'):self.verify()
    def test_policy_exact(self):
        p={'schemaVersion':1,'consoleSHA':C,'browsingSHA':B,'consoleManifestSha256':self.cp,'browsingManifestSha256':self.bp}
        self.assertEqual(M['parse_policy'](json.dumps(p),C),p)
        for change,reason in (({'schemaVersion':True},'POLICY_SCHEMA'),({'consoleSHA':B},'POLICY_SHA'),({'browsingManifestSha256':'x'},'POLICY_PIN'),({'extra':1},'POLICY_SCHEMA')):
            with self.assertRaisesRegex(ValueError,reason):M['parse_policy'](json.dumps(dict(p,**change)),C)
    def test_relative_dependency_link(self):
        d=self.b/'node_modules';d.mkdir();d.chmod(0o700)
        (d/'worker').symlink_to('../'+M['WORKER'])
        self.bm['files']=M['inventory'](self.b,os.getuid());self.bp=self.write(self.b,self.bm)
        self.verify()
    def test_directory_link_denied(self):
        d=self.b/'node_modules';d.mkdir();d.chmod(0o700);(d/'outside').symlink_to('../playwright-worker')
        with self.assertRaisesRegex(ValueError,'LINK_ESCAPE'):self.verify()
    def test_generation_drift(self):
        p=self.verify()
        self.assertEqual(M['check_generation'](p,p),p)
        with self.assertRaisesRegex(ValueError,'GENERATION_DRIFT'):M['check_generation'](p,dict(p,browsingSHA='c'*40))

def module(name):
    path=Path(__file__).resolve().parents[1]/'ops/ubuntu/deployment'/ (name+'.py')
    spec=importlib.util.spec_from_file_location(name.replace('-','_'),path)
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

class LifecycleTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        self.d=module('deploy');self.p=module('prepare');self.b=module('release-broker')
        self.pair={'status':'BROWSING_PAIR_INVENTORY_PASS','consoleSHA':C,'browsingSHA':B,
                   'consoleManifestSha256':'1'*64,'browsingManifestSha256':'2'*64,
                   'leaseModuleSha256':'3'*64,'workerSha256':'4'*64,
                   'policySha256':'5'*64,'activationEligible':False}
    def tearDown(self):self.temp.cleanup()
    def test_legacy_rollback_no_pair(self):
        old=self.root/'old';old.mkdir()
        self.assertIsNone(self.d.pair_admission(old))
        self.assertIsNone(self.d.check_pair_generation(old,{}))
    def test_prepare_before_checkpoint(self):
        c=self.root/C;o=self.root/B;c.mkdir();o.mkdir()
        deploy={'verify':lambda t:{'sourceCommit':t.name},'pair_admission':Mock(side_effect=ValueError('PAIR_POLICY_REQUIRED')),
                'preservation_admission':Mock()}
        with patch.object(self.p,'check_pending'),patch.object(self.p,'STORE_SELECTOR',return_value=self.root),patch.object(self.p,'current_release',return_value=o),patch.object(self.p,'checkpoint') as cp:
            with self.assertRaisesRegex(ValueError,'PAIR_POLICY_REQUIRED'):self.p.prepare(C,c/'ops/ubuntu/deployment',deploy,{})
            cp.assert_not_called();deploy['preservation_admission'].assert_not_called()
    def test_validate_before_service_start(self):
        (self.root/'registry.json').write_text(json.dumps({'candidate':C,'sourceSHA':C,'operatorHashes':{},'browsingPair':self.pair}))
        deploy={'release':lambda r,k:self.root/C,'check_pair_generation':Mock(side_effect=RuntimeError('PAIR_GENERATION_DRIFT')),'ctl':Mock()}
        with patch.object(self.p,'B',self.root),patch.object(self.p,'check_pending'):
            with self.assertRaisesRegex(RuntimeError,'PAIR_GENERATION_DRIFT'):self.p.validate(C,deploy,{})
            deploy['ctl'].assert_not_called()
    def test_pair_not_activation_authority(self):
        c=self.root/C;o=self.root/B;c.mkdir();o.mkdir()
        reg={'candidate':C,'rollback':B,'sourceSHA':C,'browsingPair':self.pair}
        with patch.object(self.d,'release',side_effect=lambda r,k:self.root/r[k]),patch.object(self.d,'verify',side_effect=lambda t:{'sourceCommit':t.name}),patch.object(self.d,'preservation_admission'),patch.object(self.d,'check_pair_generation',return_value=self.pair),patch.object(self.d,'atomic') as atomic,patch.object(self.d,'restart') as restart:
            with self.assertRaisesRegex(RuntimeError,'PAIRED_CUTOVER_NOT_ADMITTED'):self.d.apply(reg)
            atomic.assert_not_called();restart.assert_not_called()
    def test_broker_binding_and_supersession(self):
        cp='20261127T070000Z-'+'a'*32
        (self.root/'checkpoints'/cp).mkdir(parents=True)
        reg={'schemaVersion':2,'candidate':C,'sourceSHA':C,'rollback':B,'oldPid':123,'rollbackRegistryFingerprint':'fixture','checkpoint':cp,'browsingPair':self.pair}
        reg['browsingRuntimePlan']={'schemaVersion':1,'pair':self.pair,'baseline':{'consolePid':123,'workerState':'inactive','watchdogState':'inactive','leaseRootExisted':False},'files':{'/fixture/'+str(i):'1'*64 for i in range(6)},'activationEligible':False}
        def save(): (self.root/'registry.json').write_text(json.dumps(reg))
        save()
        with patch.object(self.b,'BASE',self.root),patch.object(self.b,'protected'):
            binding=self.b.deployment_binding(C)
            self.assertEqual(binding['browsingPair'],self.pair)
            tx={'deploymentBinding':binding}
            self.assertTrue(self.b.transaction_generation_matches(tx,C))
            reg['browsingRuntimePlan']['files']['/fixture/0']='2'*64;save()
            self.assertFalse(self.b.transaction_generation_matches(tx,C))
            reg['browsingPair']=dict(self.pair,browsingSHA='c'*40);save()
            self.assertFalse(self.b.transaction_generation_matches(tx,C))
            reg['browsingPair']=dict(self.pair,activationEligible=True);save()
            with self.assertRaisesRegex(RuntimeError,'PAIR_BINDING_INVALID'):self.b.deployment_binding(C)

if __name__=='__main__':unittest.main(verbosity=2)
