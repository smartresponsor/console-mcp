"""Unprivileged M7 regression; no root controller installation or service calls."""
import hashlib
import importlib.util
import json
import pathlib
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT=pathlib.Path(__file__).resolve().parent.parent
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/file)
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
a=load('m7_admission','ops/ubuntu/deployment/premerge-admission.py')
b=load('m7_broker','ops/ubuntu/deployment/release-broker.py')
d=load('m7_deploy','ops/ubuntu/deployment/deploy.py')
c=load('m7_client','tool/m7-premerge-client.py')
REAL_PROTECTED=a.protected
p=load('m7_provision','ops/ubuntu/deployment/premerge-provision.py')
REAL_PROVISION_PROTECT=p.protect
owner=load('m7_owner_finalize','tool/m7-owner-finalize.py')
SHA='a'*40
def digest(raw):return hashlib.sha256(raw).hexdigest()

class Broker(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=pathlib.Path(self.temp.name)
        self.cfg=b.PolicySnapshot({'schemaVersion':1,'authorizedSha':'b'*40,'enabledOperations':['prepare','validate','activate','rollback'],
            'premergeAuthorization':{'sha':SHA,'expiresAt':time.time()+600,'owner':'fixture'}},'a'*64)
        for key,value in {'BASE':self.root,'RUNS':self.root/'runs','TRANSACTIONS':self.root/'transactions','LOCK':self.root/'lock',
                          'protected':lambda p:None,'policy':lambda:self.cfg}.items():
            p=patch.object(b,key,value);p.start();self.addCleanup(p.stop)
    def req(self,**kw):
        return b.handle(dict(version=3,operation='premerge-accept',sha=SHA,confirmed=True,**kw))
    def test_no_legacy_bypass(self):
        self.assertEqual(b.handle({'version':1,'operation':'prepare','sha':SHA})['status'],'RELEASE_SHA_NOT_AUTHORIZED')
        self.assertEqual(b.handle({'version':2,'operation':'premerge-accept','sha':SHA,'confirmed':True})['status'],'RELEASE_BROKER_REQUEST_INVALID')
        self.assertEqual(self.req(transactionId='a'*32)['status'],'RELEASE_PREMERGE_REQUEST_INVALID')
    def test_request_schema(self):
        self.assertEqual(b.handle(dict(version=3,operation='premerge-accept',sha='HEAD',confirmed=True))['status'],'RELEASE_FULL_SHA_REQUIRED')
        self.assertEqual(b.handle(dict(version=3,operation='premerge-accept',sha=SHA,confirmed=False))['status'],'RELEASE_EXPLICIT_CONFIRMATION_REQUIRED')
        self.assertEqual(b.handle(dict(version=3,operation='activate',sha=SHA,confirmed=True))['status'],'RELEASE_PREMERGE_REQUEST_INVALID')
        self.assertEqual(self.req(path='/tmp/evil')['status'],'RELEASE_PREMERGE_REQUEST_INVALID')
    def test_lease(self):
        self.cfg['premergeAuthorization']['expiresAt']=time.time()-1
        self.assertEqual(self.req()['status'],'RELEASE_POLICY_LEASE_EXPIRED')
        self.cfg.pop('premergeAuthorization')
        self.assertEqual(self.req()['status'],'RELEASE_PREMERGE_SHA_NOT_AUTHORIZED')
    def test_evidence_run_not_transaction(self):
        with patch.object(b,'execute_operation',return_value={'ok':True,'status':'fixture'}):
            response=self.req();self.assertEqual(response['status'],'RELEASE_PREMERGE_ACCEPTED')
            run=response['runId']
            for _ in range(100):
                snap=b.read_record(run)
                if snap.get('run',{}).get('state')=='succeeded':break
                time.sleep(.01)
            self.assertEqual(snap['run']['state'],'succeeded')
            self.assertEqual(b.handle(dict(version=2,operation='activate',transactionId=run,confirmed=True))['status'],'RELEASE_TRANSACTION_NOT_FOUND')
            self.assertFalse((self.root/'registry.json').exists())
    def test_operator_receipt_and_production_drift(self):
        receipt=dict(status='RELEASE_PREMERGE_ACCEPTANCE_PASS',sourceSHA=SHA,activationEligible=False,productionChanged=False)
        with patch.object(b,'premerge_production_snapshot',return_value={'runtime':{'pid':'1'}}),patch.object(b,'run_executable',return_value={'ok':True,'output':json.dumps(receipt)}) as run:
            self.assertTrue(b.execute_operation(b.PREMERGE_OPERATION,SHA,self.cfg)['ok'])
            self.assertEqual(run.call_args.args[:2],(self.root/'premerge-admission.py',['--sha',SHA]))
        receipt['activationEligible']=True
        with patch.object(b,'premerge_production_snapshot',return_value={}),patch.object(b,'run_executable',return_value={'ok':True,'output':json.dumps(receipt)}):
            self.assertEqual(b.execute_operation(b.PREMERGE_OPERATION,SHA,self.cfg)['status'],'RELEASE_PREMERGE_RECEIPT_INVALID')
        with patch.object(b,'premerge_production_snapshot',side_effect=[{'pid':1},{'pid':2}]),patch.object(b,'run_executable',return_value={'ok':True,'output':'{}'}):
            self.assertEqual(b.execute_operation(b.PREMERGE_OPERATION,SHA,self.cfg)['status'],'RELEASE_PREMERGE_PRODUCTION_DRIFT')
    def test_protected_state_snapshot(self):
        with patch.object(b,'registry_status',return_value={'ok':True,'runtime':{'pid':'1','activeState':'active','loadedRelease':SHA}}):
            with self.assertRaisesRegex(RuntimeError,'RELEASE_PREMERGE_REGISTRY_UNKNOWN'):b.premerge_production_snapshot()
            f=self.root/'registry.json';f.write_text('{}')
            x=b.premerge_production_snapshot();f.write_text('{"extra":true}')
            self.assertNotEqual(x,b.premerge_production_snapshot())
        with patch.object(b,'registry_status',return_value={'ok':True,'runtime':{}}):
            with self.assertRaisesRegex(RuntimeError,'RELEASE_PREMERGE_RUNTIME_IDENTITY_UNKNOWN'):b.premerge_production_snapshot()
    def test_changed_policy(self):
        old=b.PolicySnapshot(dict(self.cfg),'b'*64)
        with patch.object(b,'run_executable') as run:
            self.assertEqual(b.execute_operation(b.PREMERGE_OPERATION,SHA,old)['status'],'RELEASE_PREMERGE_POLICY_CHANGED')
            run.assert_not_called()

class Artifact(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=pathlib.Path(self.temp.name)
        # Exercise the real byte/inventory/signature code with unprivileged files.
        # Host UID 0 path admission is separately tested negatively.
        p=patch.object(a,'protected',side_effect=lambda path,directory=False:pathlib.Path(path))
        p.start();self.addCleanup(p.stop)
    def tree(self):
        t=self.root/'artifact';t.mkdir()
        data={'package-lock.json':b'{}','package.json':b'{"type":"module"}','tsconfig.json':b'{}','dist/engine/preservation-baseline.js':b'fixture','tool/m5-manifest.json':b'{}'}
        for name,raw in data.items():
            p=t/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(raw)
        h=hashlib.sha256();h.update(b'engine/preservation-baseline.js\0fixture\0')
        m=dict(sourceCommit=SHA,files={n:digest(raw) for n,raw in data.items()},buildFingerprint=h.hexdigest()[:16],lockfileSha256=digest(data['package-lock.json']))
        raw=json.dumps(m).encode();(t/'release.json').write_bytes(raw)
        return t,m,digest(raw)
    def test_root_boundary_and_client_payload(self):
        f=self.root/'unprivileged';f.write_text('fixture')
        with self.assertRaises(PermissionError):REAL_PROTECTED(f)
        self.assertEqual(c.payload('accept',SHA,confirmed=True),dict(version=3,operation='premerge-accept',sha=SHA,confirmed=True))
        self.assertEqual(c.payload('status',run_id='a'*32),dict(version=1,operation='status',runId='a'*32))
        with self.assertRaisesRegex(ValueError,'RELEASE_EXPLICIT_CONFIRMATION_REQUIRED'):c.payload('accept',SHA)
        with self.assertRaisesRegex(ValueError,'RELEASE_FULL_SHA_REQUIRED'):c.payload('accept','HEAD',confirmed=True)
        with self.assertRaisesRegex(ValueError,'RELEASE_PREMERGE_REQUEST_INVALID'):c.payload('activate',SHA,confirmed=True)
    def test_inventory(self):
        t,m,pin=self.tree()
        self.assertEqual(a.verify_inventory(t,SHA,pin),m)
        with self.assertRaisesRegex(ValueError,'PREMERGE_INVENTORY_PIN'):a.verify_inventory(t,SHA,'0'*64)
        (t/'dist/engine/preservation-baseline.js').write_text('changed')
        with self.assertRaisesRegex(ValueError,'PREMERGE_INVENTORY_MISMATCH'):a.verify_inventory(t,SHA,pin)
    def test_link_and_extra(self):
        t,m,pin=self.tree();(t/'extra').symlink_to('/etc/passwd')
        with self.assertRaisesRegex(ValueError,'PREMERGE_INVENTORY_LINK'):a.verify_inventory(t,SHA,pin)
        (t/'extra').unlink();(t/'extra').write_text('extra')
        with self.assertRaisesRegex(ValueError,'PREMERGE_INVENTORY_MISMATCH'):a.verify_inventory(t,SHA,pin)
    def test_real_signed_source(self):
        repo=self.root/'repo';repo.mkdir()
        key=self.root/'signing'
        subprocess.run(['/usr/bin/ssh-keygen','-q','-t','ed25519','-N','','-f',str(key)],check=True)
        key.chmod(0o600) # Inherited workspace ACL must not expose fixture signing key.
        signers=self.root/'signers';signers.write_text('fixture@example.invalid '+key.with_suffix('.pub').read_text())
        fingerprint=subprocess.check_output(['/usr/bin/ssh-keygen','-lf',str(key.with_suffix('.pub'))],text=True).split()[1]
        def g(*args):
            try:return subprocess.check_output([a.GIT,'-C',str(repo),*args],env=a.ENV,stderr=subprocess.PIPE,timeout=20)
            except subprocess.CalledProcessError as e:raise AssertionError(e.stderr.decode(errors='replace')) from e
        g('init','-q','--template=','-b','premerge')
        t,m,pin=self.tree()
        for n in ('package.json','package-lock.json','tsconfig.json','tool/m5-manifest.json'):
            f=repo/n;f.parent.mkdir(exist_ok=True);f.write_bytes((t/n).read_bytes())
        g('add','--all')
        g('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','gpg.format=ssh','-c','user.signingkey='+str(key),'-c','core.hooksPath=/dev/null','commit','-S','-qm','fixture')
        sha=g('rev-parse','HEAD').decode().strip()
        bundle=self.root/'source.bundle';g('bundle','create',str(bundle),'refs/heads/premerge')
        with patch.object(a,'SIGNERS',signers):
            bare=self.root/'bare';self.assertEqual(a.verify_source(bundle,sha,fingerprint,bare),sha)
            a.verify_source_members(bare,t,sha,m['files'])
            target=self.root/'snapshot';names=a.snapshot_source(bare,target,sha)
            self.assertEqual(names,{'package.json','package-lock.json','tsconfig.json','tool/m5-manifest.json'})
            self.assertEqual((target/'package.json').read_bytes(),(t/'package.json').read_bytes())
            self.assertFalse((target/'dist').exists())
            with self.assertRaisesRegex(ValueError,'PREMERGE_SIGNATURE'):a.verify_source(bundle,sha,'SHA256:'+'A'*43,self.root/'wrong-signer')
            with self.assertRaisesRegex(ValueError,'PREMERGE_SOURCE_SHA'):a.verify_source(bundle,SHA,fingerprint,self.root/'wrong-sha')
            empty=self.root/'empty-signers';empty.write_text('')
            with patch.object(a,'SIGNERS',empty):
                with self.assertRaises(subprocess.CalledProcessError):a.verify_source(bundle,sha,fingerprint,self.root/'unknown-principal')
            changed=dict(m['files']);changed['package.json']='0'*64
            with self.assertRaisesRegex(ValueError,'PREMERGE_SOURCE_MEMBER_MISMATCH'):a.verify_source_members(bare,t,sha,changed)
    def test_rollback_never_inherits_premerge(self):
        old=self.root/'old';old.mkdir()
        rendered=d.override(old)
        self.assertIn(b'UnsetEnvironment=CONSOLE_MCP_PRESERVATION_SOCKET CONSOLE_MCP_PRESERVATION_BUNDLE_SHA256 CONSOLE_MCP_PRESERVATION_CONFIG_SHA256',rendered)
        self.assertFalse(d.PRESERVATION_CUTOVER_ENABLED)
    def test_bwrap_version_gate(self):
        with patch.object(a.subprocess,'check_output',return_value='bubblewrap 0.8.0'):
            with self.assertRaisesRegex(RuntimeError,'PREMERGE_BWRAP_UNAVAILABLE'):a.require_isolation()
        with patch.object(a.subprocess,'check_output',return_value='bubblewrap 0.9.0'):a.require_isolation()
    def test_bwrap_fixed_mount_and_identity(self):
        l=load('m7_launcher','ops/ubuntu/deployment/premerge-bwrap-launcher.py')
        run=self.root
        cfg=dict(role='engine',artifact='/opt/console-mcp-deploy/premerge-inputs/'+SHA+'/artifact',command=['/usr/bin/node','fixture'],env={})
        with patch.object(l,'protected',side_effect=lambda p,directory=False:p),patch.object(l,'private_mount',side_effect=lambda p,u,m:p):
            cmd=l.arguments(run,cfg,9,{'pid':'pid:[1]'})
            for flag in ('--unshare-pid','--unshare-net','--unshare-ipc','--unshare-uts','--unshare-cgroup','--as-pid-1','--new-session','--die-with-parent','--clearenv','--remount-ro','--seccomp'):
                self.assertIn(flag,cmd)
            self.assertNotIn('--unshare-user',cmd)
            self.assertNotIn('--ro-bind-try',cmd)
            self.assertNotIn('/home/alex',cmd)
            self.assertIn('--reuid=993',cmd);self.assertIn('--regid=1001',cmd);self.assertIn('--clear-groups',cmd)
            self.assertIn('--bounding-set=-all',cmd);self.assertIn('--no-new-privs',cmd)
            index=cmd.index('/fixture');self.assertEqual(cmd[index-2],'--ro-bind')
            cfg['role']='owner';owner=l.arguments(run,cfg,9,{'pid':'pid:[1]'})
            self.assertIn('--reuid=1000',owner);self.assertEqual(owner[owner.index('/fixture')-2],'--bind')
            cfg['role']='denied';denied=l.arguments(run,cfg,9,{'pid':'pid:[1]'})
            self.assertIn('--reuid=1000',denied);self.assertEqual(denied[denied.index('/fixture')-2],'--ro-bind')
            cfg.update(role='build',artifact=None)
            build=l.arguments(run,cfg,9,{'pid':'pid:[1]'})
            self.assertNotIn('/fixture',build);self.assertIn('/work',build);self.assertIn('/cache',build)
    def test_seccomp_real_bpf(self):
        l=load('m7_launcher_filter','ops/ubuntu/deployment/premerge-bwrap-launcher.py')
        with tempfile.TemporaryFile() as f:
            l.seccomp_program(f.fileno())
            raw=f.read()
            self.assertGreater(len(raw),64);self.assertEqual(len(raw)%8,0)
    def test_handshake_plan_generation(self):
        import types
        run=self.root/'proof';run.mkdir()
        baseline={'diffCheckOk':True,'untrackedCount':1,'worktreeFingerprint':'preservation-v3:'+'a'*64}
        proof={'status':'PREMERGE_ENGINE_HANDSHAKE_PASS','baseline':baseline}
        def fake(name,path,role):
            self.assertEqual((path,role),(run,'proof'))
            plans={k:json.loads((run/('launch-'+k+'.json')).read_bytes()) for k in ('owner','denied','engine','wire')}
            for k,p in plans.items():
                self.assertEqual(p['role'],k);self.assertEqual(p['artifact'],str(ROOT))
                self.assertEqual((run/('launch-'+k+'.json')).stat().st_mode&0o777,0o600)
                if k!='engine':compile(p['command'][4],k,'exec')
            self.assertEqual(plans['engine']['env']['CONSOLE_MCP_PRESERVATION_SOCKET'],'/fixture/s')
            self.assertEqual(plans['engine']['command'][-2:],['/artifact/dist/engine/preservation-baseline.js','/fixture/repo'])
            cfg=json.loads((run/'etc/preservation-audit.json').read_bytes())
            self.assertEqual(cfg['allowed_uids'],[993]);self.assertEqual(cfg['repositories'],{'fixture':'/fixture/repo'})
            return types.SimpleNamespace(stdout=json.dumps(dict(ownerDenied=True,socketUid=1000,socketGid=1001,engine=proof,wire=baseline)))
        with patch.object(a,'launch_unit',side_effect=fake),patch.object(a,'stop') as stop:
            out=a.handshake(ROOT,run,{})
            self.assertTrue(out['ownerDenied']);self.assertTrue(out['independentWireWitness'])
            self.assertEqual(out['isolationBackend'],'bubblewrap');stop.assert_called_once()
    def test_automated_artifact_construction_orchestration(self):
        import types
        run=self.root/'build';run.mkdir()
        source=self.root/'inputs';source.mkdir();cache=source/'npm-cache';cache.mkdir()
        (cache/'object').write_bytes(b'cached package')
        raw=json.dumps({'object':digest(b'cached package')}).encode()
        (source/'npm-cache.json').write_bytes(raw)
        def snapshot(repo,tree,sha):
            tree.mkdir();(tree/'tool').mkdir()
            (tree/'package.json').write_text(json.dumps({'scripts':{'build':'tsc -p tsconfig.json'}}))
            (tree/'package-lock.json').write_text(json.dumps({'packages':{'':{},'node_modules/typescript':{'integrity':'sha512-'+'A'*86+'==','resolved':'https://registry.npmjs.org/typescript/-/typescript.tgz'}}}))
            (tree/'tsconfig.json').write_text('{}');(tree/'tool/m5-manifest.json').write_text('{}')
        def fake_unit(name,root,role,artifact,command,wait):
            self.assertEqual((root,role,artifact,wait),(run,'build',None,True))
            compile(command[4],'fixed-build','exec')
            self.assertFalse(any((run/'private-build').iterdir()))
            self.assertEqual((run/'cache-input/object').read_bytes(),b'cached package')
            output=run/'artifact/dist/engine';output.mkdir(parents=True)
            (output/'preservation-baseline.js').write_bytes(b'compiled fixture')
            return types.SimpleNamespace(stdout='PREMERGE_OFFLINE_BUILD_PASS\n')
        with patch.object(a,'snapshot_source',side_effect=snapshot),patch.object(a,'unit',side_effect=fake_unit),patch.object(a,'stop') as stop,patch.object(a,'verify_source_members') as members:
            tree,pin=a.build_artifact(None,source,run,SHA,{'cacheManifestSha256':digest(raw)})
            m=a.verify_inventory(tree,SHA,pin)
            self.assertEqual(m['files']['dist/engine/preservation-baseline.js'],digest(b'compiled fixture'))
            self.assertEqual(m['sourceCommit'],SHA);members.assert_called_once();stop.assert_called_once()
    def test_actual_lock_contract(self):
        a.lock_contract(ROOT)
    def test_tmpfs_required_and_fixed_unit(self):
        l=load('m7_launcher_tmpfs','ops/ubuntu/deployment/premerge-bwrap-launcher.py')
        with self.assertRaisesRegex(PermissionError,'BWRAP_TMPFS_REQUIRED'):l.bounded_tmpfs(self.root,1024*1024*1024)
        for role,mount in [('build',':rw,size=1G,mode=0700,nodev,nosuid,noexec'),('proof',':rw,size=64M,mode=2710,uid=1000,gid=1001,nodev,nosuid,noexec')]:
            with patch.object(a.subprocess,'run',return_value=object()) as run:
                a.launch_unit('cmcp-premerge-'+role+'-'+'a'*12,self.root,role)
                args=run.call_args.args[0]
                self.assertIn('--uid=0',args);self.assertIn('--property=NoNewPrivileges=yes',args)
                self.assertIn('--property=KillMode=control-group',args)
                self.assertTrue(any(x.startswith('--property=TemporaryFileSystem=') and x.endswith(mount) for x in args))
                self.assertIn(str(a.BASE/'premerge-bwrap-launcher.py'),args)
                self.assertNotIn('console-mcp.service',args)
    def test_live_seccomp_filter(self):
        # Load a real generated BPF filter only in a disposable child process.
        # Never change the runner or host seccomp policy.
        import sys
        code='''import ctypes as C,importlib.util,os,socket,sys,tempfile
spec=importlib.util.spec_from_file_location("launcher",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryFile() as f:
 m.seccomp_program(f.fileno());raw=f.read()
class Prog(C.Structure):_fields_=[("len",C.c_ushort),("filter",C.c_void_p)]
buf=C.create_string_buffer(raw);prog=Prog(len(raw)//8,C.addressof(buf))
lib=C.CDLL(None,use_errno=True);lib.prctl.argtypes=[C.c_int,C.c_ulong,C.c_ulong,C.c_ulong,C.c_ulong];lib.prctl.restype=C.c_int
def filters():return int(next(x.split(":")[1] for x in open("/proc/self/status") if x.startswith("Seccomp_filters:")))
before=filters();assert lib.prctl(38,1,0,0,0)==0
assert lib.prctl(22,2,C.addressof(prog),0,0)==0,C.get_errno()
assert filters()==before+1
with socket.socket(socket.AF_UNIX):pass
try:socket.socket(socket.AF_INET)
except PermissionError:pass
else:raise AssertionError("INET socket allowed")
assert lib.unshare(0)==-1 and C.get_errno()==1
print("M7_BPF_KERNEL_ENFORCEMENT_PASS")
'''
        out=subprocess.check_output([sys.executable,'-I','-B','-c',code,str(ROOT/'ops/ubuntu/deployment/premerge-bwrap-launcher.py')],text=True,timeout=10)
        self.assertEqual(out.strip(),'M7_BPF_KERNEL_ENFORCEMENT_PASS')
    def test_offline_lock_contract(self):
        t=self.root/'lock';t.mkdir()
        (t/'package.json').write_text(json.dumps({'scripts':{'build':'tsc -p tsconfig.json'}}))
        good={'packages':{'':{},'node_modules/typescript':{'integrity':'sha512-'+'A'*86+'==','resolved':'https://registry.npmjs.org/typescript/-/typescript.tgz'}}}
        (t/'package-lock.json').write_text(json.dumps(good));a.lock_contract(t)
        good['packages']['node_modules/typescript']['resolved']='https://evil.invalid/tsc.tgz'
        (t/'package-lock.json').write_text(json.dumps(good))
        with self.assertRaisesRegex(ValueError,'PREMERGE_UNPINNED_DEPENDENCY'):a.lock_contract(t)
    def test_cache_copy_and_tamper(self):
        source=self.root/'cache';source.mkdir();(source/'data').write_bytes(b'cache')
        manifest={'data':digest(b'cache')}
        self.assertEqual(a.inventory_copy(source,self.root/'copy',expected=manifest),manifest)
        (source/'data').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'PREMERGE_CACHE_DIGEST'):a.inventory_copy(source,self.root/'changed',expected=manifest)
        (source/'link').symlink_to('/etc/passwd')
        with self.assertRaisesRegex(ValueError,'PREMERGE_COPY_FILE'):a.inventory_copy(source,self.root/'link-copy')
    def test_build_output_rejects_hardlink_and_special(self):
        import os
        source=self.root/'output';source.mkdir();(source/'a').write_bytes(b'fixture');os.link(source/'a',source/'b')
        with self.assertRaisesRegex(ValueError,'PREMERGE_COPY_FILE'):a.inventory_copy(source,self.root/'hardlink')
        (source/'b').unlink();os.mkfifo(source/'fifo')
        with self.assertRaisesRegex(ValueError,'PREMERGE_COPY_FILE'):a.inventory_copy(source,self.root/'special')
    def test_production_sealer_still_master_only(self):
        source=(ROOT/'ops/ubuntu/script/prepare-console-release.py').read_text()
        self.assertIn("git(source, 'merge-base', '--is-ancestor', args.sha, 'origin/master')",source)

class Provision(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=pathlib.Path(self.tmp.name)
        mock=patch.object(p,'protect',side_effect=lambda path,directory=False:pathlib.Path(path))
        mock.start();self.addCleanup(mock.stop)
        self.incoming=self.root/'capsule';self.incoming.mkdir()
        (self.incoming/'source.bundle').write_bytes(b'fixture bundle')
        cache=self.incoming/'npm-cache'/'_cacache';cache.mkdir(parents=True)
        (cache/'entry').write_bytes(b'fixture cache')
        self.cache={'_cacache/entry':digest(b'fixture cache')}
        (self.incoming/'npm-cache.json').write_text(json.dumps(self.cache))
        self.approved={}
        for name in p.OPS:
            raw=name.encode();(self.incoming/name).write_bytes(raw);self.approved[name]=digest(raw)
        self.signer='SHA256:'+'A'*43
        self.manifest=dict(schemaVersion=1,sourceSHA=SHA,signerFingerprint=self.signer,lockfileSha256='b'*64,sourceBundleSha256=digest(b'fixture bundle'),cacheManifestSha256=digest((self.incoming/'npm-cache.json').read_bytes()),operators=self.approved)
        raw=json.dumps(self.manifest).encode();(self.incoming/'capsule.json').write_bytes(raw);self.pin=digest(raw)
    def check(self):
        return p.validate_capsule(self.incoming,SHA,self.pin,self.signer,self.approved)
    def test_exact_capsule_pins(self):
        self.assertEqual(self.check(),self.manifest)
        (self.incoming/'premerge-admission.py').write_bytes(b'wrong')
        with self.assertRaisesRegex(ValueError,'PROVISION_OPERATOR_PIN'):self.check()
    def test_capsule_extra_and_bad_pin(self):
        with self.assertRaisesRegex(ValueError,'PROVISION_CAPSULE_PIN'):
            p.validate_capsule(self.incoming,SHA,'0'*64,self.signer,self.approved)
        (self.incoming/'extra').write_bytes(b'x')
        with self.assertRaisesRegex(ValueError,'PROVISION_CAPSULE_MEMBERS'):self.check()
    def test_cache_inventory_and_tampering(self):
        target=self.root/'copy';target.mkdir()
        p.cache_inventory(self.incoming/'npm-cache',self.cache,target)
        self.assertEqual((target/'_cacache/entry').read_bytes(),b'fixture cache')
        (self.incoming/'npm-cache/_cacache/entry').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'PROVISION_CACHE_DIGEST'):p.cache_inventory(self.incoming/'npm-cache',self.cache)
    def test_root_owned_import_required(self):
        with self.assertRaises(PermissionError):REAL_PROVISION_PROTECT(self.incoming,True)
    def test_owner_finalize_contract(self):
        self.assertEqual(owner.BASE,'c4ee750507f22525e3a379bb20890e20d74847bf')
        self.assertIn('ops/ubuntu/deployment/premerge-provision.py',owner.FILES)
        self.assertEqual(len(owner.FILES),len(set(owner.FILES)))
        self.assertNotIn('tool/m7-bwrap-probe.ps1',owner.FILES)

if __name__=='__main__':unittest.main()
