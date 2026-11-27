#!/usr/bin/python3
import hashlib,runpy,tempfile,unittest
from pathlib import Path
M=runpy.run_path(str(Path(__file__).resolve().parents[1]/'ops/ubuntu/deployment/browsing-pair-runtime.py'))
C='a'*40
B='b'*40
CONSOLE=M['BASE']/'releases'/C
BROWSING=M['BASE']/'browsing-releases'/C/B
P={'status':'BROWSING_PAIR_INVENTORY_PASS','consoleSHA':C,'browsingSHA':B,'consoleManifestSha256':'1'*64,'browsingManifestSha256':'2'*64,'leaseModuleSha256':'3'*64,'workerSha256':'4'*64,'policySha256':'5'*64,'activationEligible':False}
class RuntimeTest(unittest.TestCase):
    def setUp(self):
        self.values={(M['WORKER'],'LoadState'):'loaded',(M['WORKER'],'ActiveState'):'inactive',(M['WORKER'],'MainPID'):'0',(M['CONSOLE'],'ActiveState'):'active',(M['CONSOLE'],'MainPID'):'123',(M['WATCHDOG'],'ActiveState'):'inactive'}
        self.present=set()
    def show(self,u,p):return self.values.get((u,p),'')
    def exists(self,p):return p in self.present
    def plan(self):return M['initial_plan'](CONSOLE,BROWSING,P,self.show,self.exists)
    def test_render(self):
        a=M['render'](CONSOLE,BROWSING,P)
        self.assertEqual(len(a),6)
        self.assertIn(b'BROWSER_MCP_CONSOLE_ROOT='+str(CONSOLE).encode(),a[M['WORKER_ENV']])
        self.assertIn(b'BROWSER_MCP_CORE_DOMAIN_DEFINITIONS_PATH='+str(BROWSING).encode(),a[M['CONSOLE_ENV']])
        self.assertIn(b'CONSOLE_MCP_WATCHDOG_ALLOW_RESTARTS=false',a[M['WATCHDOG_ENV']])
        self.assertNotIn(b'TOKEN',b''.join(a.values()))
        self.assertFalse(self.plan()['activationEligible'])
    def test_bad_pair(self):
        with self.assertRaisesRegex(ValueError,'PAIR_RUNTIME_ROOT'):M['render'](CONSOLE,BROWSING.parent/'other',P)
        with self.assertRaisesRegex(ValueError,'PAIR_RUNTIME_BINDING'):M['render'](CONSOLE,BROWSING,dict(P,activationEligible=True))
    def test_active_worker(self):
        self.values[(M['WORKER'],'ActiveState')]='active'
        with self.assertRaisesRegex(ValueError,'WORKER_NOT_INACTIVE'):self.plan()
    def test_existing_root(self):
        self.present.add(M['LEASE'])
        with self.assertRaisesRegex(ValueError,'ROOT_ALREADY_EXISTS'):self.plan()
    def test_existing_dropin(self):
        self.present.add(M['WORKER_ENV'])
        with self.assertRaisesRegex(ValueError,'DROPIN_ALREADY_EXISTS'):self.plan()
    def test_watchdog_active(self):
        self.values[(M['WATCHDOG'],'ActiveState')]='activating'
        with self.assertRaisesRegex(ValueError,'WATCHDOG_IN_FLIGHT'):self.plan()
    def test_coupling(self):
        self.values[(M['WORKER'],'PartOf')]=M['CONSOLE']
        with self.assertRaisesRegex(ValueError,'UNEXPECTED_UNIT_COUPLING'):self.plan()
    def test_pid_drift(self):
        expected=self.plan()
        self.values[(M['CONSOLE'],'MainPID')]='124'
        with self.assertRaisesRegex(ValueError,'PLAN_DRIFT'):M['verify_plan'](expected,CONSOLE,BROWSING,P,self.show,self.exists)
    def procs(self):
        shared=dict(uid=993,leaseIdentity='1:2',leaseMode=0o700,leaseUid=993,lockModuleSha256=P['leaseModuleSha256'])
        env=dict(M['LEASE_NAMES'],BROWSER_MCP_BROWSER_WORKER_TOKEN='a'*32)
        c=dict(shared,pid=123,env=dict(env,BROWSER_MCP_BROWSER_WORKER_URL='http://127.0.0.1:8791',BROWSER_MCP_CORE_DOMAIN_DEFINITIONS_PATH=str(BROWSING/M['DEFINITIONS'])))
        w=dict(shared,pid=456,env=dict(env,BROWSER_MCP_CONSOLE_ROOT=str(CONSOLE),PORT='8791',BROWSER_MCP_WORKER_PORT='8791',BROWSER_MCP_REMOTE_DEBUGGING_PORT='9223',BROWSER_MCP_EXTERNAL_VISIBLE_BROWSER='true',BROWSER_MCP_HEADLESS='false',BROWSER_MCP_WORKER_DRAIN_TOKEN='b'*32),argv=['/usr/bin/node',str(BROWSING/'playwright-worker/src/worker.js')],workerSha256=P['workerSha256'])
        return c,w
    def test_effective(self):
        c,w=self.procs()
        self.assertEqual(M['verify_effective'](CONSOLE,BROWSING,P,c,w)['status'],'PAIR_EFFECTIVE_RUNTIME_PASS')
    def test_effective_mismatch(self):
        for field,value,reason in [('uid',1000,'UID'),('leaseIdentity','1:3','LEASE_INODE'),('leaseMode',0o770,'LEASE_MODE'),('lockModuleSha256','0'*64,'MODULE'),('argv',['/usr/bin/node','/tmp/worker.js'],'WORKER_ENTRYPOINT')]:
            c,w=self.procs();w[field]=value
            with self.assertRaisesRegex(ValueError,'PAIR_EFFECTIVE_'+reason):M['verify_effective'](CONSOLE,BROWSING,P,c,w)
    def test_effective_secret_mismatch(self):
        c,w=self.procs();w['env']['BROWSER_MCP_WORKER_DRAIN_TOKEN']='a'*32
        with self.assertRaisesRegex(ValueError,'PAIR_EFFECTIVE_AUTH'):M['verify_effective'](CONSOLE,BROWSING,P,c,w)
if __name__=='__main__':unittest.main(verbosity=2)
