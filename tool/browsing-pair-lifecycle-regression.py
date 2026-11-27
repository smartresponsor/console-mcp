#!/usr/bin/python3
import copy,hashlib,os,runpy,tempfile,unittest
from pathlib import Path
D=Path(__file__).resolve().parents[1]/'ops/ubuntu/deployment'
M=runpy.run_path(str(D/'browsing-pair-lifecycle.py'))
J=runpy.run_path(str(D/'browsing-pair-cutover.py'))
P=runpy.run_path(str(D/'browsing-pair-publication.py'))
C='a'*40;B='b'*40
PAIR=dict(consoleSHA=C,browsingSHA=B,activationEligible=False)
FILES=P['FILES'];DATA={p:('fixture:'+str(p)+'\n').encode() for p in FILES}
PLAN=dict(pair=PAIR,baseline=dict(consolePid=123),activationEligible=False,files={str(p):hashlib.sha256(v).hexdigest() for p,v in DATA.items()})
REG=dict(candidate=C,sourceSHA=C,rollback='c'*40,checkpoint='20261127T080000Z-'+'d'*32,oldPid=123,browsingPair=PAIR,browsingRuntimePlan=PLAN)
class Host:
    def __init__(self,fd):
        self.fd=fd;self.calls=[];self.denied=set();self.closed=False;self.worker=False;self.selected='legacy';self.installed=False;self.journal=None
    def record(self,n):self.calls.append(n);return n not in self.denied
    def verify_generation(self,b):return self.record('generation')
    def verify_preservation(self,b):return self.record('preservation')
    def verify_incumbent_ingress(self,b):return self.record('incumbent')
    def verify_worker_startup_exclusion(self,b):return self.record('startup')
    def verify_external_quiescence_contract(self,b):return self.record('external_contract')
    def verify_rollback_checkpoint(self,b):return self.record('checkpoint')
    def verify_recovery_identity(self,b):return self.record('identity')
    def close_ingress(self,g):self.closed=True;return self.record('close')
    def quiesce_console(self,g,b):return self.closed and self.record('console_drain')
    def quiesce_external(self,g,b):return self.closed and self.record('external_drain')
    def assert_excluded(self,g,b):return self.closed and self.record('excluded')
    def publish_pair(self,b,g,install):
        if not self.closed:return False
        P['reconcile'](self.fd,DATA,b['plan'],g,os.getuid(),install)
        self.installed=install
        return self.record('publish' if install else 'restore')
    def reload_units(self):return self.closed and self.record('reload')
    def start_drained_worker(self,b,g):
        if not self.closed or not self.installed:return False
        self.worker=True;return self.record('worker_start')
    def switch_console(self,b,g,new):
        if not self.closed:return False
        self.selected='candidate' if new else 'legacy'
        return self.record('switch' if new else 'legacy')
    def verify_paired_runtime(self,b,g):return self.closed and self.worker and self.installed and self.selected=='candidate' and self.record('verify_pair')
    def drain_worker_if_present(self,b,g):return self.closed and self.record('worker_drain')
    def stop_exact_worker(self,b,g):self.worker=False;return self.closed and self.record('worker_stop')
    def restore_checkpoint(self,b,g):return self.closed and self.record('restore_checkpoint')
    def verify_rollback_runtime(self,b,g):return self.closed and not self.worker and not self.installed and self.selected=='legacy' and self.record('verify_legacy')
    def verify_decided_runtime(self,b,g,d):
        return self.journal['decision']==('committed' if d=='forward' else 'rolled_back') and self.selected==('candidate' if d=='forward' else 'legacy')
    def resume_selected_ingress(self,b,g,d):self.closed=False;return self.record('resume')
class Test(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory();r=Path(self.t.name)
        for p in ('opt','opt/console-mcp-deploy','etc','etc/systemd','etc/systemd/system'):
            q=r/p;q.mkdir(mode=0o700);q.chmod(0o700)
        self.fd=os.open(r,os.O_RDONLY|os.O_DIRECTORY)
        self.h=Host(self.fd);self.a=M['Lifecycle'](J['binding'](REG),self.h)
    def tearDown(self):os.close(self.fd);self.t.cleanup()
    def write(self,s):self.h.journal=copy.deepcopy(s)
    def apply(self):return J['apply'](REG,self.write,self.a)
    def recover(self,explicit=False):return J['recover'](self.h.journal,REG,self.write,self.a,explicit)
    def test_roundtrip(self):
        self.assertEqual(self.apply()['phase'],'committed')
        self.assertFalse(self.h.closed)
        self.assertTrue(self.h.worker)
        self.assertEqual(self.recover(True)['phase'],'rolled_back')
        self.assertFalse(self.h.closed);self.assertFalse(self.h.worker);self.assertFalse(self.h.installed)
        self.assertTrue(P['verify_all'](self.fd,DATA,os.getuid(),False))
    def test_all_preflight_gates(self):
        for gate in ('generation','preservation','incumbent','startup','external_contract','checkpoint'):
            self.h.denied={gate}
            with self.assertRaises(RuntimeError):self.apply()
            self.assertIsNone(self.h.journal);self.assertFalse(self.h.closed);self.assertFalse(self.h.installed)
    def test_failure_after_actual_publication(self):
        self.h.denied={'publish'}
        with self.assertRaisesRegex(RuntimeError,'PUBLICATION'):self.apply()
        self.assertTrue(self.h.closed);self.assertTrue(self.h.installed)
        self.h.denied.clear()
        self.assertEqual(self.recover()['phase'],'rolled_back')
        self.assertTrue(P['verify_all'](self.fd,DATA,os.getuid(),False))
    def test_failure_after_worker_start(self):
        self.h.denied={'worker_start'}
        with self.assertRaisesRegex(RuntimeError,'WORKER_START'):self.apply()
        self.assertTrue(self.h.worker);self.assertTrue(self.h.closed)
        self.h.denied.clear();self.recover()
        self.assertFalse(self.h.worker);self.assertFalse(self.h.closed)
    def test_identity_drift(self):
        self.h.denied={'identity'}
        with self.assertRaisesRegex(RuntimeError,'RECOVERY_IDENTITY'):self.apply()
        self.assertFalse(self.h.closed)
    def test_denied_step(self):
        with self.assertRaisesRegex(RuntimeError,'STEP_DENIED'):self.a.step('forward','restart_legacy',J['binding'](REG))
if __name__=='__main__':unittest.main(verbosity=2)
