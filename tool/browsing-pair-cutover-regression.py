#!/usr/bin/python3
import copy,json,os,runpy,tempfile,unittest
from pathlib import Path
M=runpy.run_path(str(Path(__file__).resolve().parents[1]/'ops/ubuntu/deployment/browsing-pair-cutover.py'))
C='a'*40
B='b'*40
P=dict(consoleSHA=C,browsingSHA=B,activationEligible=False)
R=dict(candidate=C,sourceSHA=C,rollback='c'*40,checkpoint='20261127T080000Z-'+'d'*32,oldPid=123,browsingPair=P,browsingRuntimePlan=dict(pair=P,baseline=dict(consolePid=123),activationEligible=False))
class Crash(BaseException):pass
class Backend:
    def __init__(self):self.calls=[];self.fail=None;self.ready=True
    def preflight(self,b):return self.ready
    def step(self,d,s,b):
        self.calls.append((d,s))
        if self.fail==(d,s):raise Crash()
        return True
class Test(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.path=Path(self.tmp.name)/'transaction.json'
        self.b=Backend()
    def tearDown(self):self.tmp.cleanup()
    def write(self,s):
        p=self.path.with_suffix('.tmp')
        with p.open('w') as f:json.dump(s,f);f.flush();os.fsync(f.fileno())
        p.replace(self.path)
    def state(self):return json.loads(self.path.read_text())
    def apply(self):return M['apply'](R,self.write,self.b)
    def recover(self,explicit=False):return M['recover'](self.state(),R,self.write,self.b,explicit)
    def test_success(self):
        a=self.apply();self.assertEqual(a['phase'],'committed')
        self.assertEqual(a['completed'],list(M['FORWARD']))
        self.assertEqual(self.recover(),a)
    def test_preflight_denial(self):
        self.b.ready=False
        with self.assertRaisesRegex(RuntimeError,'PREFLIGHT_DENIED'):self.apply()
        self.assertFalse(self.path.exists());self.assertEqual(self.b.calls,[])
    def test_each_forward_crash(self):
        for s in M['FORWARD']:
            with self.subTest(step=s):
                self.b=Backend();self.b.fail=('forward',s)
                with self.assertRaises(Crash):self.apply()
                self.assertEqual(self.state()['intent'],s)
                self.b.fail=None
                a=self.recover()
                if s=='resume_ingress':
                    self.assertEqual(a['phase'],'committed')
                    self.assertEqual(self.b.calls.count(('forward',s)),2)
                    self.assertFalse(any(d=='rollback' for d,k in self.b.calls))
                else:
                    self.assertEqual(a['phase'],'rolled_back')
                    self.assertEqual(a['forwardEvidence']['intent'],s)
                    self.assertEqual(self.b.calls[-len(M['ROLLBACK']):],[('rollback',k) for k in M['ROLLBACK']])
                n=len(self.b.calls);self.recover();self.assertEqual(len(self.b.calls),n)
    def test_each_rollback_crash(self):
        for s in M['ROLLBACK']:
            with self.subTest(step=s):
                self.b=Backend();self.apply()
                self.b.fail=('rollback',s)
                with self.assertRaises(Crash):self.recover(True)
                self.assertEqual(self.state()['intent'],s)
                self.b.fail=None
                a=self.recover()
                self.assertEqual(a['phase'],'rolled_back')
                self.assertEqual(self.b.calls.count(('rollback',s)),2)
    def test_opening_decision_durable_before_effect(self):
        original=self.b.step
        def step(d,s,b):
            if s=='resume_ingress':
                self.assertEqual(self.state()['decision'],'committed' if d=='forward' else 'rolled_back')
            return original(d,s,b)
        self.b.step=step
        self.apply();self.recover(True)
    def test_post_open_write_failure_never_rolls_back(self):
        def write(s):
            if s['phase']=='pending' and 'resume_ingress' in s['completed']:raise OSError('fixture disk failure')
            self.write(s)
        with self.assertRaises(OSError):M['apply'](R,write,self.b)
        self.assertEqual(self.state()['decision'],'committed')
        self.assertEqual(self.recover()['phase'],'committed')
        self.assertFalse(any(d=='rollback' for d,k in self.b.calls))
    def test_wrong_generation(self):
        self.apply();r=copy.deepcopy(R);r['checkpoint']='20261127T080001Z-'+'d'*32
        with self.assertRaisesRegex(RuntimeError,'BINDING_DRIFT'):M['recover'](self.state(),r,self.write,self.b,True)
    def test_rollback_preserves_binding(self):
        a=self.apply();b=self.recover(True)
        self.assertEqual(a['bindingSha256'],b['bindingSha256'])
    def test_corrupt_sequence(self):
        a=self.apply();a['completed']=['resume_ingress']
        with self.assertRaisesRegex(RuntimeError,'SEQUENCE'):M['recover'](a,R,self.write,self.b,True)
    def test_unverified_step(self):
        self.b.step=lambda *args:False
        with self.assertRaisesRegex(RuntimeError,'STEP_UNVERIFIED'):self.apply()
        self.assertEqual(self.state()['intent'],'quiesce')
    def test_failed_journal_write_precedes_effect(self):
        def denied(s):
            if s['intent']=='install_pair':raise OSError('fixture disk failure')
            self.write(s)
        with self.assertRaises(OSError):M['apply'](R,denied,self.b)
        self.assertNotIn(('forward','install_pair'),self.b.calls)
        self.assertEqual(self.state()['completed'],['quiesce'])
if __name__=='__main__':unittest.main(verbosity=2)
