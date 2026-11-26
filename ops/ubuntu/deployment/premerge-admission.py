#!/usr/bin/python3
"""Installed, reviewed root operator. Pre-merge evidence, never a production release.

Inputs are a root-provisioned signed Git bundle and pinned offline cache (v2),
or an independently built root-owned artifact (v1). This operator never executes
candidate source as root or promotes artifacts.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import time
import uuid

BASE = Path('/opt/console-mcp-deploy')
INPUT = BASE / 'premerge-inputs'
EVIDENCE = BASE / 'premerge-evidence'
POLICY = BASE / 'premerge-policy.json'
SIGNERS = BASE / 'premerge-allowed-signers'
GIT = '/usr/bin/git'
SHA = re.compile('[0-9a-f]{40}')
DIGEST = re.compile('[0-9a-f]{64}')
NAMES = ('preservation_ipc','preservation_hardened','preservation_activation',
         'preservation_identity','preservation_server_v3')
MODULES = {'preservation_bundle.py','collector_windows.py'} | {n+'.py' for n in NAMES}
ENV = {'PATH':'/usr/bin:/bin','HOME':'/nonexistent','LC_ALL':'C',
       'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null',
       'GIT_TERMINAL_PROMPT':'0','GIT_NO_REPLACE_OBJECTS':'1',
       'GIT_ALLOW_PROTOCOL':'file','GIT_OPTIONAL_LOCKS':'0'}

def unique(pairs):
    result={}
    for k,v in pairs:
        if k in result:raise ValueError('PREMERGE_DUPLICATE_KEY')
        result[k]=v
    return result

def protected(path, directory=False):
    path=Path(path)
    if not path.is_absolute() or '..' in path.parts:raise ValueError('PREMERGE_PATH')
    for p in (*reversed(path.parents),path):
        st=p.lstat()
        if st.st_uid!=0 or st.st_mode&0o022 or stat.S_ISLNK(st.st_mode):
            raise PermissionError('PREMERGE_UNTRUSTED_PATH')
        if p!=path or directory:
            if not stat.S_ISDIR(st.st_mode):raise PermissionError('PREMERGE_DIRECTORY')
        elif not stat.S_ISREG(st.st_mode) or st.st_nlink!=1:
            raise PermissionError('PREMERGE_FILE')
    return path

def stamp(s):
    return (s.st_dev,s.st_ino,s.st_uid,s.st_mode,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)

def digest(path, limit=512*1024*1024):
    path=protected(path)
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as f:
        a=os.fstat(f.fileno())
        if a.st_size>limit or stamp(a)!=stamp(path.lstat()):raise ValueError('PREMERGE_FILE_CHANGED')
        h=hashlib.sha256();total=0
        while True:
            chunk=f.read(1024*1024)
            if not chunk:break
            total+=len(chunk)
            if total>limit:raise ValueError('PREMERGE_FILE_LIMIT')
            h.update(chunk)
        if total!=a.st_size or stamp(a)!=stamp(os.fstat(f.fileno())) or stamp(a)!=stamp(path.lstat()):
            raise ValueError('PREMERGE_FILE_CHANGED')
    return h.hexdigest()

def read_json(path):
    protected(path)
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as stream:
        a=os.fstat(stream.fileno());raw=stream.read(16*1024*1024+1)
        if len(raw)>16*1024*1024 or len(raw)!=a.st_size or stamp(a)!=stamp(os.fstat(stream.fileno())) or stamp(a)!=stamp(path.lstat()):raise ValueError('PREMERGE_JSON_CHANGED')
    return json.loads(raw,object_pairs_hook=unique)

def policy(sha):
    p=read_json(POLICY)
    common={'schemaVersion','sha','bundleSha256','signerFingerprint','expiresAt'}
    if type(p) is not dict or type(p.get('schemaVersion')) is not int or p['schemaVersion'] not in (1,2,3):raise ValueError('PREMERGE_POLICY')
    if p['schemaVersion']==3:
        common|={'lockfileSha256','operators'}
        if type(p.get('operators')) is not dict or set(p['operators'])!={'premerge-admission.py','premerge-bwrap-launcher.py','premerge-provision.py'} or any(type(v) is not str or not DIGEST.fullmatch(v) for v in p['operators'].values()) or type(p.get('lockfileSha256')) is not str or not DIGEST.fullmatch(p['lockfileSha256']):raise ValueError('PREMERGE_OPERATOR_POLICY')
    pin='artifactManifestSha256' if p['schemaVersion']==1 else 'cacheManifestSha256'
    if set(p)!=common|{pin} or p['sha']!=sha:raise ValueError('PREMERGE_POLICY')
    if not all(type(p[k]) is str and DIGEST.fullmatch(p[k]) for k in (pin,'bundleSha256')):
        raise ValueError('PREMERGE_POLICY_DIGEST')
    if type(p['signerFingerprint']) is not str or not re.fullmatch(r'SHA256:[A-Za-z0-9+/]{43}',p['signerFingerprint']):
        raise ValueError('PREMERGE_SIGNER')
    if type(p['expiresAt']) not in (int,float) or not time.time()<p['expiresAt']<time.time()+86400:
        raise ValueError('PREMERGE_LEASE')
    protected(SIGNERS)
    return p

def git(repo,*args):
    if os.geteuid()==0:raise PermissionError('PREMERGE_GIT_ROOT_FORBIDDEN')
    try:
        return subprocess.check_output([GIT,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',
            '-c','gpg.format=ssh','-c','gpg.ssh.program=/usr/bin/ssh-keygen',
            '-c','gpg.ssh.allowedSignersFile='+str(SIGNERS),'--git-dir='+str(repo),*args],
            env=ENV,stderr=subprocess.PIPE,timeout=90)
    except subprocess.CalledProcessError as exc:
        detail=(exc.stderr or b'')[-2048:].decode('utf-8',errors='replace')
        raise RuntimeError('PREMERGE_GIT_FAILED:'+str(args[0])+':exit='+str(exc.returncode)+':stderr='+json.dumps(detail,ensure_ascii=True)) from None

def verify_source(bundle,sha,expected_signer,repo):
    if os.geteuid()==0:raise PermissionError('PREMERGE_GIT_ROOT_FORBIDDEN')
    protected(bundle)
    subprocess.run([GIT,'init','--bare','--template=',str(repo)],env=ENV,check=True,
                   stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=10)
    git(repo,'fetch','--no-tags','--no-write-fetch-head',str(bundle),'refs/heads/premerge:refs/heads/premerge')
    if git(repo,'rev-parse','refs/heads/premerge^{commit}').decode().strip()!=sha:
        raise ValueError('PREMERGE_SOURCE_SHA')
    git(repo,'verify-commit',sha)
    result=git(repo,'show','-s','--format=%G?%n%GF',sha).decode().strip().splitlines()
    if result!=['G',expected_signer]:raise ValueError('PREMERGE_SIGNATURE')
    return sha

def verify_inventory(tree,sha,expected):
    protected(tree,True)
    manifest_path=tree/'release.json'
    if digest(manifest_path)!=expected:raise ValueError('PREMERGE_INVENTORY_PIN')
    m=read_json(manifest_path)
    if set(m)!={'sourceCommit','files','buildFingerprint','lockfileSha256'} or m['sourceCommit']!=sha or type(m['files']) is not dict:
        raise ValueError('PREMERGE_INVENTORY_SCHEMA')
    files={};total=0;total_bytes=0
    for p in tree.rglob('*'):
        if p==manifest_path:continue
        total+=1
        if total>150000:raise ValueError('PREMERGE_INVENTORY_LIMIT')
        if p.is_symlink():
            # No linked source or executable in this evidence artifact.
            raise ValueError('PREMERGE_INVENTORY_LINK')
        if p.is_dir():protected(p,True);continue
        protected(p);total_bytes+=p.stat().st_size
        if total_bytes>2*1024*1024*1024:raise ValueError('PREMERGE_INVENTORY_BYTES_LIMIT')
        files[p.relative_to(tree).as_posix()]=digest(p)
    if files!=m['files'] or files.get('package-lock.json')!=m['lockfileSha256']:
        raise ValueError('PREMERGE_INVENTORY_MISMATCH')
    fingerprint=hashlib.sha256()
    for name in sorted(n for n in files if n.startswith('dist/')):
        fingerprint.update(name[5:].encode());fingerprint.update(b'\0')
        raw=(tree/name).read_bytes()
        if hashlib.sha256(raw).hexdigest()!=files[name]:raise ValueError('PREMERGE_BUILD_CHANGED')
        fingerprint.update(raw);fingerprint.update(b'\0')
    if m['buildFingerprint']!=fingerprint.hexdigest()[:16] or 'dist/engine/preservation-baseline.js' not in files:
        raise ValueError('PREMERGE_BUILD_FINGERPRINT')
    return m

def verify_source_members(repo,tree,sha,files):
    # Compare every admitted tracked source member, not mutable checkout bytes.
    wanted=('src','tool','policy','config','ops','bin','prompt','package.json','package-lock.json','tsconfig.json')
    raw=git(repo,'ls-tree','-rz','--full-tree',sha,'--',*wanted)
    names=set()
    for entry in raw.split(b'\0'):
        if not entry:continue
        meta,name=entry.split(b'\t',1)
        mode,kind,oid=meta.decode('ascii').split(' ')
        name=name.decode('utf-8')
        if mode not in ('100644','100755') or kind!='blob' or name in names or any(x in ('','.','..') for x in name.split('/')):
            raise ValueError('PREMERGE_SOURCE_MEMBER')
        names.add(name)
        if len(names)>150000 or int(git(repo,'cat-file','-s',oid))>16*1024*1024:raise ValueError('PREMERGE_SOURCE_LIMIT')
        if name not in files or hashlib.sha256(git(repo,'cat-file','blob',oid)).hexdigest()!=files[name]:
            raise ValueError('PREMERGE_SOURCE_MEMBER_MISMATCH:'+name)
    for name in files:
        if name not in names and not name.startswith('dist/'):raise ValueError('PREMERGE_EXTRA_SOURCE')
    if not {'package.json','package-lock.json','tool/m5-manifest.json'}<=names:
        raise ValueError('PREMERGE_SOURCE_INCOMPLETE')

def write(path,raw,mode=0o644):
    with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode),'wb') as f:
        f.write(raw);f.flush();os.fsync(f.fileno())
    path.chmod(mode)

def require_isolation():
    # Only independently installed, root-owned launcher. No source checkout fallback.
    protected(BASE/'premerge-bwrap-launcher.py')
    result=subprocess.check_output(['/usr/bin/bwrap','--version'],env=ENV,text=True,timeout=10)
    match=re.fullmatch(r'bubblewrap (\d+)\.(\d+)\.(\d+)\s*',result)
    if not match or tuple(map(int,match.groups()))<(0,9,0):raise RuntimeError('PREMERGE_BWRAP_UNAVAILABLE')

def write_plan(run,role,artifact,command,env=None):
    plan=run/('launch-'+role+'.json')
    write(plan,json.dumps(dict(role=role,artifact=str(artifact) if artifact else None,command=command,env=env or {})).encode(),0o600)
    return plan

def launch_unit(name,run,role):
    launcher=protected(BASE/'premerge-bwrap-launcher.py')
    if role not in ('source','build','proof'):raise ValueError('PREMERGE_UNIT_ROLE')
    duration={'source':240,'build':650,'proof':200}[role]
    args=['/usr/bin/systemd-run','--quiet','--unit='+name,'--collect','--service-type=exec','--uid=0',
          '--property=NoNewPrivileges=yes','--property=UMask=0077','--property=KillMode=control-group',
          '--property=TimeoutStopSec=5s','--property=RuntimeMaxSec='+str(duration),
          '--property=MemoryMax=2G','--property=TasksMax=128','--property=LimitFSIZE='+('536870912' if role in ('source','build') else '1048576'),
          '--property=CapabilityBoundingSet=CAP_SYS_ADMIN CAP_SYS_CHROOT CAP_SETUID CAP_SETGID CAP_SETPCAP CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_NET_ADMIN']
    if role in ('source','build'):
        args+=['--property=TemporaryFileSystem='+str(run/('private-'+role))+':rw,size=1G,mode=0700,nodev,nosuid,noexec']
        selector=['--plan',str(run/('launch-'+role+'.json'))]
    else:
        # The isolated owner is namespace PID 1 and may ignore SIGTERM.
        # After the main launcher exits, systemd must reap the entire disposable
        # proof cgroup immediately. A nonzero main exit is still a failure.
        args+=['--property=KillSignal=SIGKILL']
        # Both proof peers bind the same bounded fixture tmpfs, in separate
        # Bubblewrap namespaces within this ONE transient unit.
        args+=['--property=TemporaryFileSystem='+str(run/'owner')+':rw,size=64M,mode=2710,uid=1000,gid=1001,nodev,nosuid,noexec']
        selector=['--proof',str(run)]
    if not re.fullmatch(r'cmcp-premerge-(?:source|proof|build)-[0-9a-f]{12}',name):raise ValueError('PREMERGE_UNIT_NAME')
    write(run/('unit-'+name),b'planned\n',0o600)
    fd=os.open(run,os.O_DIRECTORY);os.fsync(fd);os.close(fd)
    try:
        return subprocess.run([*args,'--wait','--pipe','--','/usr/bin/python3','-I','-B',str(launcher),*selector],
                              capture_output=True,text=True,timeout=duration+15,check=True)
    except subprocess.CalledProcessError as exc:
        # systemd-run --pipe bypasses journald; retain bounded failure evidence
        # in the root-private run directory. Never interpret candidate output.
        detail=(exc.stderr or '')[-4096:]
        evidence={'unit':name,'role':role,'exitCode':exc.returncode,'stderr':detail}
        write(run/('failure-'+name+'.json'),(json.dumps(evidence,ensure_ascii=True)+'\n').encode(),0o600)
        fd=os.open(run,os.O_DIRECTORY);os.fsync(fd);os.close(fd)
        raise RuntimeError('PREMERGE_UNIT_FAILED:'+role+':exit='+str(exc.returncode)+':stderr='+json.dumps(detail[-1000:],ensure_ascii=True)) from None

def unit(name,run,role,artifact,command,wait=False,env=None):
    if role not in ('source','build') or not wait:raise ValueError('PREMERGE_UNIT_ROLE')
    write_plan(run,role,artifact,command,env)
    return launch_unit(name,run,role)

def stop(name):
    if not re.fullmatch(r'cmcp-premerge-(?:source|proof|build)-[0-9a-f]{12}',name):raise ValueError('PREMERGE_UNIT_NAME')
    subprocess.run(['/usr/bin/systemctl','stop',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False,timeout=20)
    state=subprocess.run(['/usr/bin/systemctl','show',name,'-p','ActiveState','--value'],capture_output=True,text=True,timeout=10)
    if state.returncode!=0 or state.stdout.strip() not in ('inactive','failed'):
        loaded=subprocess.run(['/usr/bin/systemctl','show',name,'-p','LoadState','--value'],capture_output=True,text=True,timeout=10)
        if loaded.stdout.strip()!='not-found':raise RuntimeError('PREMERGE_CLEANUP_FAILED')
    events=Path('/sys/fs/cgroup/system.slice')/(name+'.service')/'cgroup.events'
    if events.exists() and 'populated 0' not in events.read_text().splitlines():raise RuntimeError('PREMERGE_CGROUP_STILL_POPULATED')

def expected_fixture_baseline():
    # Independent oracle: canonical fixture bytes, not candidate Git/IPC output.
    def obj(kind,raw):
        return hashlib.sha1(kind.encode()+b' '+str(len(raw)).encode()+b'\0'+raw).hexdigest()
    old=obj('blob',b'baseline\n');new=obj('blob',b'modified\n')
    tree=obj('tree',b'100644 a\0'+bytes.fromhex(old))
    ident=b'Fixture <fixture@example.invalid> 1700000000 +0000'
    head=obj('commit',b'tree '+tree.encode()+b'\nauthor '+ident+b'\ncommitter '+ident+b'\n\nfixture\n')
    status=b' M a\0?? untracked\0'
    unstaged=(f'diff --git a/a b/a\nindex {old[:7]}..{new[:7]} 100644\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-baseline\n+modified\n').encode()
    name=b'untracked'
    untracked=len(name).to_bytes(8,'big')+name+(stat.S_IFREG|0o600).to_bytes(4,'big')+hashlib.sha256(b'new\n').digest()
    packed=b''.join(len(part).to_bytes(8,'big')+part for part in (status,b'',unstaged,untracked))
    return dict(fingerprintVersion='preservation-v3',diffCheckOk=True,head=head,
                statusHash=hashlib.sha256(status).hexdigest(),
                worktreeFingerprint='preservation-v3:'+hashlib.sha256(b'preservation-v3\0'+packed).hexdigest(),untrackedCount=1)

def validate_handshake_evidence(evidence):
    if type(evidence) is not dict or evidence.get('ownerDenied') is not True or evidence.get('socketUid')!=1000 or evidence.get('socketGid')!=1001:
        raise ValueError('PREMERGE_OWNER_DENIAL_MISSING')
    proof=evidence.get('engine')
    if type(proof) is not dict or proof.get('status')!='PREMERGE_ENGINE_HANDSHAKE_PASS':raise ValueError('PREMERGE_ENGINE_PROOF')
    expected=expected_fixture_baseline()
    if evidence.get('wire')!=proof.get('baseline'):raise ValueError('PREMERGE_WIRE_WITNESS_MISMATCH')
    if proof.get('baseline')!=expected:raise ValueError('PREMERGE_EXPECTED_BASELINE_MISMATCH')
    return proof

def handshake(tree,run,manifest):
    protected(run,True)
    owner=run/'owner';owner.mkdir(mode=0o700);owner.chmod(0o700)
    config=run/'etc';config.mkdir(mode=0o755);config.chmod(0o755)
    opt=run/'opt';opt.mkdir(mode=0o755);opt.chmod(0o755)
    bundle=opt/'preservation-audit';bundle.mkdir(mode=0o755);bundle.chmod(0o755)
    m=read_json(tree/'tool/m5-manifest.json')
    if type(m) is not dict or set(m)!=MODULES:raise ValueError('PREMERGE_BUNDLE_MANIFEST')
    for name,d in m.items():
        source=tree/'tool'/name
        if not DIGEST.fullmatch(d) or digest(source)!=d:raise ValueError('PREMERGE_MODULE')
        write(bundle/name,source.read_bytes())
    write(bundle/'manifest.json',json.dumps({n:m[n+'.py'] for n in NAMES}).encode())
    bid=hashlib.sha256(json.dumps({n:d for n,d in m.items() if n!='preservation_bundle.py'},sort_keys=True,separators=(',',':')).encode('ascii')).hexdigest()
    sock='/fixture/s'
    cfg=dict(source='/opt/console-mcp/preservation-audit/collector_windows.py',sha256=m['collector_windows.py'],
             root='/fixture',repositories={'fixture':'/fixture/repo'},store='/fixture/reports',allowed_uids=[993],socket=sock,bundle_sha256=bid)
    raw=json.dumps(cfg,sort_keys=True,separators=(',',':')).encode('ascii');cid=hashlib.sha256(raw).hexdigest()
    write(config/'preservation-audit.json',raw)
    name='cmcp-premerge-proof-'+uuid.uuid4().hex[:12]
    # Fixed wrapper seeds a fixture, binds as UID 1000, then execs candidate
    # bootstrap with an inherited listener. No production socket/user manager.
    wrapper="""import os,socket,subprocess,sys
r,s=sys.argv[1:]
assert os.getpid()==1 and os.getuid()==1000
assert 'NoNewPrivs:\\t1' in open('/proc/self/status').read()
os.umask(0o077)
e={'PATH':'/usr/bin:/bin','HOME':'/nonexistent','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','LC_ALL':'C','GIT_AUTHOR_DATE':'1700000000 +0000','GIT_COMMITTER_DATE':'1700000000 +0000'}
def g(*a):return subprocess.check_output(['/usr/bin/git','-C',r,*a],env=e)
g('init','-q','--template=','--object-format=sha1','-b','fixture');g('config','user.name','Fixture');g('config','user.email','fixture@example.invalid')
open(r+'/a','w').write('baseline\\n');g('add','a');g('-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-qm','fixture')
open(r+'/a','w').write('modified\\n');open(r+'/untracked','w').write('new\\n')
sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);sock.bind(s);assert os.stat(s).st_gid==1001;os.chmod(s,0o660);sock.listen(8)
os.dup2(sock.fileno(),3,inheritable=True);os.set_inheritable(3,True)
os.execve('/usr/bin/python3',['python3','-I','-B','/opt/console-mcp/preservation-audit/preservation_bundle.py'],dict(e,LISTEN_PID=str(os.getpid()),LISTEN_FDS='1'))
"""
    # Only the fixed installed operator emits readiness/receipt. Candidate code
    # is run at low privilege inside restricted transient units.
    probe="""import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
assert.equal(process.pid,1);assert.equal(process.getuid(),993);
const m=await import(pathToFileURL(process.argv[1]).href);
const b=await m.captureOwnerBaseline(process.argv[2]);
assert(b.diffCheckOk&&b.untrackedCount===1);assert.match(b.worktreeFingerprint,/^preservation-v3:[a-f0-9]{64}$/);
for(const key of ['CONSOLE_MCP_PRESERVATION_BUNDLE_SHA256','CONSOLE_MCP_PRESERVATION_CONFIG_SHA256']){
 const old=process.env[key];process.env[key]=(old[0]==='0'?'1':'0')+old.slice(1);
 await assert.rejects(m.captureOwnerBaseline(process.argv[2]),/PRESERVATION_.*IDENTITY_MISMATCH/);process.env[key]=old;
}
console.log(JSON.stringify({status:'PREMERGE_ENGINE_HANDSHAKE_PASS',baseline:b}));"""
    denied="""import json,os,socket,struct,sys
assert os.getuid()==1000 and os.getpid()==1
with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
 s.settimeout(35);s.connect('/fixture/s')
 assert struct.unpack('3i',s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]==1000
 s.sendall(json.dumps(dict(version=1,operation='baseline',requestId='owner-denied',repository='fixture')).encode()+b'\\n')
 with s.makefile('rb') as f:raw=f.readline(65537)
 assert len(raw)<=65536 and json.loads(raw)==dict(status='REJECTED',reason='PEER_DENIED')
print('PREMERGE_OWNER_DENIED_PASS')
"""
    env={'CONSOLE_MCP_PRESERVATION_SOCKET':sock,
         'CONSOLE_MCP_PRESERVATION_BUNDLE_SHA256':bid,'CONSOLE_MCP_PRESERVATION_CONFIG_SHA256':cid}
    # Independent fixed wire witness; candidate client output alone is not evidence.
    witness="""import json,os,socket,struct,sys,uuid
path,workspace,bid,cid=sys.argv[1:]
assert os.getuid()==993 and os.getpid()==1
assert 'NoNewPrivs:\\t1' in open('/proc/self/status').read()
def call(alias):
 request=dict(version=1,operation='baseline',requestId=str(uuid.uuid4()),repository=alias)
 with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
  s.settimeout(35);s.connect(path)
  assert struct.unpack('3i',s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]==1000
  s.sendall(json.dumps(request).encode()+b'\\n')
  with s.makefile('rb') as f:raw=f.readline(65537)
  assert raw.endswith(b'\\n') and len(raw)<=65536
  reply=json.loads(raw);assert reply['requestId']==request['requestId']
  return reply
r=call('fixture')
assert r['status']=='BASELINE_COMPLETE' and r['uid']==1000 and r['workspace']==workspace
assert r['attestation']==dict(bundleSha256=bid,configSha256=cid)
b=r['baseline'];assert b['diffCheckOk'] is True and b['untrackedCount']==1 and b['fingerprintVersion']=='preservation-v3'
b['worktreeFingerprint']='preservation-v3:'+b['worktreeFingerprint']
assert call('unknown-repository')['status']=='REJECTED'
print(json.dumps(b))
"""
    write_plan(run,'owner',tree,['/usr/bin/python3','-I','-B','-c',wrapper,'/fixture/repo',sock])
    write_plan(run,'denied',tree,['/usr/bin/python3','-I','-B','-c',denied])
    write_plan(run,'engine',tree,['/usr/bin/node','--input-type=module','-e',probe,'/artifact/dist/engine/preservation-baseline.js','/fixture/repo'],env)
    write_plan(run,'wire',tree,['/usr/bin/python3','-I','-B','-c',witness,sock,'/fixture/repo',bid,cid])
    try:
        result=launch_unit(name,run,'proof')
        evidence=json.loads(result.stdout,object_pairs_hook=unique)
        proof=validate_handshake_evidence(evidence)
        return {'bundleSha256':bid,'configSha256':cid,'engine':proof,'ownerUid':1000,'clientUid':993,'independentWireWitness':True,'expectedBaselineVerified':True,'ownerDenied':True,'isolationBackend':'bubblewrap'}
    finally:stop(name)

def snapshot_source(repo,tree,sha):
    """Extract exact committed blobs without tar extraction or worktree code."""
    wanted=('src','tool','policy','config','ops','bin','prompt','package.json','package-lock.json','tsconfig.json')
    tree.mkdir(mode=0o755);tree.chmod(0o755)
    raw=git(repo,'ls-tree','-rz','--full-tree',sha,'--',*wanted)
    seen=set();total=0
    for entry in raw.split(b'\0'):
        if not entry:continue
        meta,name=entry.split(b'\t',1);mode,kind,oid=meta.decode('ascii').split(' ');name=name.decode('utf8')
        if mode not in ('100644','100755') or kind!='blob' or name in seen or any(x in ('','.','..') for x in name.split('/')):
            raise ValueError('PREMERGE_SOURCE_MEMBER')
        seen.add(name);size=int(git(repo,'cat-file','-s',oid));total+=size
        if len(seen)>150000 or size>16*1024*1024 or total>512*1024*1024:raise ValueError('PREMERGE_SOURCE_LIMIT')
        data=git(repo,'cat-file','blob',oid)
        if len(data)!=size:raise ValueError('PREMERGE_SOURCE_CHANGED')
        target=tree/name;target.parent.mkdir(mode=0o755,parents=True,exist_ok=True)
        for parent in target.parents:
            if parent==tree:break
            parent.chmod(0o755)
        write(target,data,0o755 if mode=='100755' else 0o644)
    if not {'package.json','package-lock.json','tsconfig.json','tool/m5-manifest.json'}<=seen:
        raise ValueError('PREMERGE_SOURCE_INCOMPLETE')
    return seen

def lock_contract(tree):
    package=read_json(tree/'package.json');lock=read_json(tree/'package-lock.json')
    if package.get('scripts',{}).get('build')!='tsc -p tsconfig.json' or type(lock.get('packages')) is not dict:
        raise ValueError('PREMERGE_BUILD_CONTRACT')
    for name,item in lock['packages'].items():
        if not name:continue
        if (type(item) is not dict or item.get('link') or type(item.get('integrity')) is not str or
            not re.fullmatch(r'sha512-[A-Za-z0-9+/]{86}==',item['integrity']) or
            type(item.get('resolved')) is not str or not item['resolved'].startswith('https://registry.npmjs.org/')):
            raise ValueError('PREMERGE_UNPINNED_DEPENDENCY')
        if len(base64.b64decode(item['integrity'][7:],validate=True))!=64:raise ValueError('PREMERGE_UNPINNED_DEPENDENCY')
    if 'node_modules/typescript' not in lock['packages']:raise ValueError('PREMERGE_TYPESCRIPT_MISSING')

def inventory_copy(source,target,owner=None,expected=None,limit=2*1024*1024*1024):
    """Copy regular files from a closed/private tree; never follow links or special files."""
    st=source.lstat()
    if not stat.S_ISDIR(st.st_mode):raise ValueError('PREMERGE_COPY_ROOT')
    target.mkdir(mode=0o700);target.chmod(0o700)
    seen={};count=0;total=0
    for base,dirs,files in os.walk(source,followlinks=False):
        rel=Path(base).relative_to(source);dst=target/rel
        for name in sorted(dirs):
            p=Path(base)/name;s=p.lstat();count+=1
            if count>150000:raise ValueError('PREMERGE_COPY_LIMIT')
            if not stat.S_ISDIR(s.st_mode):raise ValueError('PREMERGE_COPY_LINK')
            (dst/name).mkdir(mode=0o700)
        for name in sorted(files):
            p=Path(base)/name;s=p.lstat();count+=1;total+=s.st_size
            if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_size>512*1024*1024:
                raise ValueError('PREMERGE_COPY_FILE')
            if count>150000 or total>limit:raise ValueError('PREMERGE_COPY_LIMIT')
            key=p.relative_to(source).as_posix()
            if expected is not None and key not in expected:raise ValueError('PREMERGE_CACHE_EXTRA')
            with os.fdopen(os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as stream:
                a=os.fstat(stream.fileno())
                if stamp(a)!=stamp(s):raise ValueError('PREMERGE_COPY_CHANGED')
                h=hashlib.sha256()
                out=dst/name
                with os.fdopen(os.open(out,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb') as dest:
                    remaining=s.st_size
                    while remaining:
                        data=stream.read(min(remaining,1024*1024))
                        if not data:raise ValueError('PREMERGE_COPY_CHANGED')
                        dest.write(data);h.update(data);remaining-=len(data)
                    if stream.read(1) or stamp(a)!=stamp(os.fstat(stream.fileno())) or stamp(a)!=stamp(p.lstat()):
                        raise ValueError('PREMERGE_COPY_CHANGED')
                    dest.flush();os.fsync(dest.fileno())
                seen[key]=h.hexdigest()
                if expected is not None and seen[key]!=expected[key]:raise ValueError('PREMERGE_CACHE_DIGEST')
    if expected is not None and seen!=expected:raise ValueError('PREMERGE_CACHE_INVENTORY')
    for path in [target,*target.rglob('*')]:
        if owner is not None:os.chown(path,owner,1001)
        path.chmod((0o700 if path.is_dir() else 0o600) if owner is not None else (0o755 if path.is_dir() else 0o644))
    return seen

def source_inventory(tree):
    protected(tree,True)
    return {p.relative_to(tree).as_posix():digest(p) for p in tree.rglob('*') if not p.is_dir()}

def verify_snapshot_members(snapshot,files):
    expected=source_inventory(snapshot)
    if {n:v for n,v in files.items() if not n.startswith('dist/')}!=expected:
        raise ValueError('PREMERGE_SOURCE_MEMBER_MISMATCH')

def parse_source(sha,signer):
    # Only fixed installed code, never candidate code, parses the bundle.
    if os.getuid()!=993 or os.geteuid()!=993 or os.getpid()!=1:raise PermissionError('PREMERGE_SOURCE_SANDBOX_REQUIRED')
    global SIGNERS
    SIGNERS=Path('/source-input/allowed-signers')
    repo=Path('/work/source.git');tree=Path('/work/snapshot')
    verify_source(Path('/source-input/source.bundle'),sha,signer,repo)
    snapshot_source(repo,tree,sha)
    print('PREMERGE_SIGNED_SOURCE_PASS',flush=True)

def import_source(source,run,sha,p):
    incoming=run/'source-input';incoming.mkdir(mode=0o755);incoming.chmod(0o755)
    for name,path in (('source.bundle',source/'source.bundle'),('allowed-signers',SIGNERS),('admission.py',BASE/'premerge-admission.py')):
        pin=digest(path)
        raw=path.read_bytes()
        if hashlib.sha256(raw).hexdigest()!=pin:raise ValueError('PREMERGE_SOURCE_INPUT_CHANGED')
        if name=='source.bundle' and pin!=p['bundleSha256']:raise ValueError('PREMERGE_BUNDLE_PIN')
        write(incoming/name,raw)
    private=run/'private-source';private.mkdir(mode=0o700);private.chmod(0o700)
    name='cmcp-premerge-source-'+uuid.uuid4().hex[:12]
    try:
        result=unit(name,run,'source',None,['/usr/bin/python3','-I','-B','/source-input/admission.py','--parse-source','--sha',sha,'--signer',p['signerFingerprint']],True)
        if result.stdout.strip()!='PREMERGE_SIGNED_SOURCE_PASS':raise ValueError('PREMERGE_SOURCE_PROOF')
    finally:stop(name)
    snapshot=run/'source-snapshot'
    members=source_inventory(snapshot)
    if not {'package.json','package-lock.json','tsconfig.json','tool/m5-manifest.json'}<=set(members):raise ValueError('PREMERGE_SOURCE_INCOMPLETE')
    if p['schemaVersion']==3:
        if members['package-lock.json']!=p['lockfileSha256']:raise ValueError('PREMERGE_LOCKFILE_PIN')
        for op,pin in p['operators'].items():
            if members.get('ops/ubuntu/deployment/'+op)!=pin or digest(BASE/op)!=pin:raise ValueError('PREMERGE_OPERATOR_SOURCE')
    return snapshot

def build_artifact(snapshot,source,run,sha,p):
    # Root never executes npm, tsc, package scripts or candidate controllers.
    # Signed source remains root-owned; a separate writable copy is used inside
    # the closed UID 993 sandbox. Only regular dist files are imported after exit.
    tree=run/'artifact';inventory_copy(snapshot,tree,limit=512*1024*1024);lock_contract(tree)
    cache_manifest=source/'npm-cache.json'
    if digest(cache_manifest)!=p['cacheManifestSha256']:raise ValueError('PREMERGE_CACHE_PIN')
    cache=read_json(cache_manifest)
    if type(cache) is not dict or not cache or any(type(k) is not str or type(v) is not str or not DIGEST.fullmatch(v) for k,v in cache.items()):
        raise ValueError('PREMERGE_CACHE_SCHEMA')
    cache_root=protected(source/'npm-cache',True)
    for member in cache_root.rglob('*'):protected(member,member.is_dir())
    private=run/'private-build';private.mkdir(mode=0o700);private.chmod(0o700)
    # Cache input is immutable and private to the root operator. The launcher
    # populates a size-limited per-unit tmpfs; no writable host build mount.
    inventory_copy(cache_root,run/'cache-input',expected=cache,limit=512*1024*1024)
    command="""import os,subprocess
assert os.getuid()==993 and os.getpid()==1
env={'PATH':'/usr/bin:/bin','HOME':'/tmp','LC_ALL':'C','NODE_DISABLE_COMPILE_CACHE':'1',
     'npm_config_userconfig':'/dev/null','npm_config_globalconfig':'/tmp/empty-global.npmrc','npm_config_registry':'https://registry.npmjs.org/',
     'npm_config_ignore_scripts':'true','npm_config_offline':'true','npm_config_audit':'false','npm_config_fund':'false'}
subprocess.run(['/usr/bin/node','/usr/lib/node_modules/npm/bin/npm-cli.js','ci','--offline','--ignore-scripts','--no-audit','--no-fund','--cache','/cache'],cwd='/work',env=env,check=True,timeout=360)
subprocess.run(['/usr/bin/node','/work/node_modules/typescript/bin/tsc','-p','/work/tsconfig.json'],cwd='/work',env=env,check=True,timeout=180)
print('PREMERGE_OFFLINE_BUILD_PASS')
"""
    name='cmcp-premerge-build-'+uuid.uuid4().hex[:12]
    try:
        result=unit(name,run,'build',None,['/usr/bin/python3','-I','-B','-c',command],True)
        if not result.stdout.rstrip().endswith('PREMERGE_OFFLINE_BUILD_PASS'):raise ValueError('PREMERGE_BUILD_FAILED')
    finally:stop(name)
    # The trusted launcher imported only regular, bounded dist files after
    # Bubblewrap PID 1 exited. All unit processes are now stopped; its tmpfs is gone.
    protected(tree/'dist',True)
    files={p.relative_to(tree).as_posix():digest(p) for p in tree.rglob('*') if p.is_file()}
    fingerprint=hashlib.sha256()
    for key in sorted(n for n in files if n.startswith('dist/')):
        fingerprint.update(key[5:].encode());fingerprint.update(b'\0');fingerprint.update((tree/key).read_bytes());fingerprint.update(b'\0')
    m=dict(sourceCommit=sha,files=files,buildFingerprint=fingerprint.hexdigest()[:16],lockfileSha256=files['package-lock.json'])
    write(tree/'release.json',(json.dumps(m,sort_keys=True)+'\n').encode())
    pin=digest(tree/'release.json')
    verify_inventory(tree,sha,pin);verify_snapshot_members(snapshot,files)
    return tree,pin

def toolchain_identity():
    paths={'bwrap':'/usr/bin/bwrap','setpriv':'/usr/bin/setpriv','node':'/usr/bin/node',
           'npm-cli':'/usr/lib/node_modules/npm/bin/npm-cli.js','python':'/usr/bin/python3',
           'git':'/usr/bin/git','ssh-keygen':'/usr/bin/ssh-keygen','libseccomp':'/usr/lib/x86_64-linux-gnu/libseccomp.so.2',
           'admission':str(BASE/'premerge-admission.py'),'launcher':str(BASE/'premerge-bwrap-launcher.py'),'provisioner':str(BASE/'premerge-provision.py')}
    result={}
    for name,path in paths.items():
        real=Path(path).resolve(strict=True)
        result[name]={'path':str(real),'sha256':digest(real)}
    return result

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--sha',required=True);parser.add_argument('--parse-source',action='store_true');parser.add_argument('--signer');parser.add_argument('--run-id');args=parser.parse_args()
    if args.parse_source:
        if args.run_id or not SHA.fullmatch(args.sha) or not args.signer or not re.fullmatch(r'SHA256:[A-Za-z0-9+/]{43}',args.signer):raise ValueError('PREMERGE_SOURCE_ARGS')
        parse_source(args.sha,args.signer);return
    if args.signer or os.geteuid()!=0 or not SHA.fullmatch(args.sha):raise SystemExit('PREMERGE_ROOT_AND_SHA_REQUIRED')
    sha=args.sha;p=policy(sha)
    # Older authorization schemas do not bind the independently approved
    # installed operator identities. Require the stronger v3 contract.
    if p['schemaVersion']!=3:raise PermissionError('PREMERGE_POLICY_V3_REQUIRED')
    for name,pin in p['operators'].items():
        if digest(BASE/name)!=pin:raise PermissionError('PREMERGE_OPERATOR_PIN')
    require_isolation()
    toolchain=toolchain_identity();signers_pin=digest(SIGNERS)
    source=protected(INPUT/sha,True);bundle=source/'source.bundle'
    if digest(bundle)!=p['bundleSha256']:raise ValueError('PREMERGE_BUNDLE_PIN')
    protected(EVIDENCE,True)
    if args.run_id:
        if not re.fullmatch(r'm7-[0-9a-f]{8}',args.run_id):raise ValueError('PREMERGE_RUN_ID')
        run=EVIDENCE/args.run_id
    else:run=EVIDENCE/('m7-'+uuid.uuid4().hex[:8])
    run.mkdir(mode=0o700);run.chmod(0o700)
    fd=os.open(EVIDENCE,os.O_DIRECTORY);os.fsync(fd);os.close(fd)
    # Import only the independently pinned installed administrative helper.
    import runpy
    helper=runpy.run_path(str(BASE/'premerge-provision.py'),run_name='installed_premerge_continuity')
    before=None;after=None;receipt=None;error=None;failures=[];cleaned=[]
    try:
        before=helper['snapshot']()
        snapshot=import_source(source,run,sha,p)
        source_pin=hashlib.sha256(json.dumps(source_inventory(snapshot),sort_keys=True,separators=(',',':')).encode()).hexdigest()
        tree,pin=build_artifact(snapshot,source,run,sha,p)
        m=verify_inventory(tree,sha,pin)
        verify_snapshot_members(snapshot,m['files'])
        proof=handshake(tree,run,m)
        verify_inventory(tree,sha,pin)
        verify_snapshot_members(snapshot,m['files'])
        if hashlib.sha256(json.dumps(source_inventory(snapshot),sort_keys=True,separators=(',',':')).encode()).hexdigest()!=source_pin:raise ValueError('PREMERGE_SOURCE_SNAPSHOT_CHANGED')
        if digest(bundle)!=p['bundleSha256']:raise ValueError('PREMERGE_BUNDLE_CHANGED')
        if digest(source/'npm-cache.json')!=p['cacheManifestSha256']:raise ValueError('PREMERGE_CACHE_PIN_CHANGED')
        if policy(sha)!=p:raise ValueError('PREMERGE_POLICY_CHANGED')
        if toolchain_identity()!=toolchain or digest(SIGNERS)!=signers_pin:raise ValueError('PREMERGE_TOOLCHAIN_CHANGED')
        receipt={'status':'RELEASE_PREMERGE_ACCEPTANCE_PASS','sourceSHA':sha,'inventorySha256':pin,'buildMode':'offline-bwrap',
                 'sourceSnapshotSha256':source_pin,'cacheManifestSha256':p['cacheManifestSha256'],'toolchainEntrypoints':toolchain,
                 'sourceBundleSha256':p['bundleSha256'],'signerFingerprint':p['signerFingerprint'],'signersSha256':signers_pin,
                 'buildFingerprint':m['buildFingerprint'],'proof':proof,'activationEligible':False,'productionChanged':False}
    except BaseException as exc:
        error=exc
        raise
    finally:
        try:cleaned=helper['cleanup_run'](run.name)
        except BaseException as exc:failures.append('cleanup:'+type(exc).__name__)
        try:after=helper['snapshot']()
        except BaseException as exc:failures.append('continuity:'+type(exc).__name__)
        if before is None or after!=before:failures.append('production_drift_or_unknown')
        status=dict(status='M7_ADMISSION_CLEANUP_PASS' if not failures else 'M7_ADMISSION_CLEANUP_FAILED',
                    sourceSHA=sha,runId=run.name,before=before,after=after,cleanedUnits=cleaned,
                    failures=failures,errorType=type(error).__name__ if error else None,activationEligible=False)
        helper['atomic_json'](run/'cleanup.json',status)
        if failures:raise RuntimeError('PREMERGE_CONTINUITY_OR_CLEANUP_FAILED')
    # Success is emitted only after mandatory cleanup and continuity.
    receipt['cleanupSha256']=digest(run/'cleanup.json')
    helper['atomic_json'](run/'receipt.json',receipt)
    print(json.dumps(dict(receipt,receiptPath=str(run/'receipt.json'))))

if __name__=='__main__':main()
