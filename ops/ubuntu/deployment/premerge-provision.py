#!/usr/bin/python3
"""Independently reviewed root-only administrative provisioning. Never modifies the production broker."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import time

BASE=Path('/opt/console-mcp-deploy')
INCOMING=BASE/'premerge-incoming'
INPUT=BASE/'premerge-inputs'
EVIDENCE=BASE/'premerge-evidence'
POLICY=BASE/'premerge-policy.json'
SIGNERS=BASE/'premerge-allowed-signers'
OPS=('premerge-admission.py','premerge-bwrap-launcher.py','premerge-provision.py')
SHA=re.compile('[0-9a-f]{40}')
DIGEST=re.compile('[0-9a-f]{64}')
ENV={'PATH':'/usr/bin:/bin','HOME':'/nonexistent','LC_ALL':'C','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_NO_REPLACE_OBJECTS':'1','GIT_TERMINAL_PROMPT':'0','GIT_ALLOW_PROTOCOL':'file'}

def unique(pairs):
    d={}
    for k,v in pairs:
        if k in d:raise ValueError('PROVISION_DUPLICATE_KEY')
        d[k]=v
    return d

def protect(path,directory=False):
    path=Path(path)
    if not path.is_absolute() or '..' in path.parts:raise ValueError('PROVISION_PATH')
    for p in (*reversed(path.parents),path):
        s=p.lstat()
        if s.st_uid!=0 or s.st_mode&0o022 or stat.S_ISLNK(s.st_mode):raise PermissionError('PROVISION_UNTRUSTED_PATH')
        if p!=path or directory:
            if not stat.S_ISDIR(s.st_mode):raise PermissionError('PROVISION_DIRECTORY')
        elif not stat.S_ISREG(s.st_mode) or s.st_nlink!=1:raise PermissionError('PROVISION_FILE')
    return path

def raw(path,limit=512*1024*1024):
    path=protect(path)
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as f:
        a=os.fstat(f.fileno())
        if a.st_size>limit:raise ValueError('PROVISION_SIZE')
        b=f.read(limit+1);c=os.fstat(f.fileno());n=path.lstat()
        stamp=lambda x:(x.st_dev,x.st_ino,x.st_mode,x.st_uid,x.st_nlink,x.st_size,x.st_mtime_ns,x.st_ctime_ns)
        if len(b)!=a.st_size or stamp(a)!=stamp(c) or stamp(a)!=stamp(n):raise ValueError('PROVISION_CHANGED')
        return b

def digest(b):return hashlib.sha256(b).hexdigest()
def read_json(path):return json.loads(raw(path,16*1024*1024),object_pairs_hook=unique)
def write(path,data,mode=0o600):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
    with os.fdopen(fd,'wb') as f:
        f.write(data);f.flush();os.fsync(f.fileno())
    path.chmod(mode)

def sync(path):
    fd=os.open(path,os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)

def ensure_dir(p):
    if not p.exists():p.mkdir(mode=0o700)
    protect(p,True)
    if stat.S_IMODE(p.stat().st_mode)!=0o700:raise PermissionError('PROVISION_PRIVATE_DIR')

def validate_capsule(incoming,sha,pin,signer,approved):
    if set(p.name for p in incoming.iterdir())!={'capsule.json','source.bundle','npm-cache','npm-cache.json',*OPS}:
        raise ValueError('PROVISION_CAPSULE_MEMBERS')
    data=raw(incoming/'capsule.json',65536)
    if digest(data)!=pin:raise ValueError('PROVISION_CAPSULE_PIN')
    m=json.loads(data,object_pairs_hook=unique)
    if type(m) is not dict or set(m)!={'schemaVersion','sourceSHA','signerFingerprint','lockfileSha256','sourceBundleSha256','cacheManifestSha256','operators'} or m['schemaVersion']!=1 or m['sourceSHA']!=sha or m['signerFingerprint']!=signer or m['operators']!=approved:
        raise ValueError('PROVISION_CAPSULE_IDENTITY')
    if any(type(m[k]) is not str or not DIGEST.fullmatch(m[k]) for k in ('lockfileSha256','sourceBundleSha256','cacheManifestSha256')):raise ValueError('PROVISION_DIGEST')
    if digest(raw(incoming/'source.bundle'))!=m['sourceBundleSha256'] or digest(raw(incoming/'npm-cache.json',16*1024*1024))!=m['cacheManifestSha256']:
        raise ValueError('PROVISION_INPUT_PIN')
    for name in OPS:
        if digest(raw(incoming/name,1024*1024))!=approved[name]:raise ValueError('PROVISION_OPERATOR_PIN')
    return m

def cache_inventory(cache,expected,copy_to=None):
    protect(cache,True)
    if type(expected) is not dict or not expected or len(expected)>10000:raise ValueError('PROVISION_CACHE_SCHEMA')
    found={};total=0
    for p in cache.rglob('*'):
        if p.is_symlink():raise ValueError('PROVISION_CACHE_LINK')
        if p.is_dir():protect(p,True);continue
        key=p.relative_to(cache).as_posix()
        if key not in expected or not key.startswith('_cacache/') or type(expected[key]) is not str or not DIGEST.fullmatch(expected[key]):
            raise ValueError('PROVISION_CACHE_MEMBER')
        data=raw(p,64*1024*1024);total+=len(data)
        if total>512*1024*1024 or digest(data)!=expected[key]:raise ValueError('PROVISION_CACHE_DIGEST')
        found[key]=digest(data)
        if copy_to is not None:
            q=copy_to/key;q.parent.mkdir(mode=0o700,parents=True,exist_ok=True);write(q,data)
    if found!=expected:raise ValueError('PROVISION_CACHE_INVENTORY')

def verify_git(incoming,sha,signer,m,approved,repo):
    subprocess.run(['/usr/bin/git','init','--bare','--template=',str(repo)],env=ENV,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=10)
    def g(*args):
        return subprocess.check_output(['/usr/bin/git','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','gpg.format=ssh','-c','gpg.ssh.program=/usr/bin/ssh-keygen','-c','gpg.ssh.allowedSignersFile='+str(SIGNERS),'--git-dir='+str(repo),*args],env=ENV,stderr=subprocess.PIPE,timeout=180)
    g('fetch','--no-tags','--no-write-fetch-head',str(incoming/'source.bundle'),'refs/heads/premerge:refs/heads/premerge')
    if g('rev-parse','refs/heads/premerge^{commit}').decode().strip()!=sha:raise ValueError('PROVISION_GIT_SHA')
    g('verify-commit',sha)
    if g('show','-s','--format=%G?%n%GF',sha).decode().strip().splitlines()!=['G',signer]:raise ValueError('PROVISION_SIGNER')
    if digest(g('show',sha+':package-lock.json'))!=m['lockfileSha256']:raise ValueError('PROVISION_LOCKFILE')
    for name in OPS:
        if digest(g('show',sha+':ops/ubuntu/deployment/'+name))!=approved[name]:raise ValueError('PROVISION_OPERATOR_SOURCE')

def snapshot():
    r=raw(BASE/'registry.json',1024*1024)
    journal=BASE/'transaction.json'
    state=subprocess.check_output(['/usr/bin/systemctl','show','console-mcp.service','-p','MainPID','-p','ActiveState','-p','BindReadOnlyPaths'],env=ENV,text=True,timeout=10)
    fields=dict(line.split('=',1) for line in state.splitlines() if '=' in line)
    if fields.get('ActiveState')!='active' or not re.fullmatch('[1-9][0-9]*',fields.get('MainPID','')) or not fields.get('BindReadOnlyPaths'):raise RuntimeError('PROVISION_RUNTIME_UNKNOWN')
    return {'registrySha256':digest(r),'transactionSha256':digest(raw(journal,1024*1024)) if journal.exists() else None,'runtime':fields}

def provision(args):
    sha=args.sha;incoming=protect(INCOMING/sha,True)
    approved=dict(zip(OPS,(args.admission_sha,args.launcher_sha,args.provision_sha)))
    if digest(raw(Path(__file__)))!=approved['premerge-provision.py']:raise ValueError('PROVISION_SELF_PIN')
    m=validate_capsule(incoming,sha,args.capsule_sha,args.signer,approved)
    protect(SIGNERS)
    expected=read_json(incoming/'npm-cache.json');cache_inventory(incoming/'npm-cache',expected)
    ensure_dir(INPUT);ensure_dir(EVIDENCE)
    # Never overwrite any existing policy or candidate. Independent operator
    # installation may reuse only byte-identical reviewed root-owned files.
    if os.path.lexists(POLICY) or os.path.lexists(INPUT/sha):raise FileExistsError('PROVISION_EXISTING_STATE')
    for name in OPS[:2]:
        target=BASE/name
        if os.path.lexists(target) and digest(raw(target,1024*1024))!=approved[name]:raise FileExistsError('PROVISION_OPERATOR_EXISTS')
    work=Path(tempfile.mkdtemp(prefix='.provision-',dir=INPUT));work.chmod(0o700)
    try:
        verify_git(incoming,sha,args.signer,m,approved,work/'source.git')
        staged=work/'inputs';staged.mkdir(mode=0o700)
        (staged/'npm-cache').mkdir(mode=0o700)
        write(staged/'source.bundle',raw(incoming/'source.bundle'))
        write(staged/'npm-cache.json',raw(incoming/'npm-cache.json'))
        cache_inventory(incoming/'npm-cache',expected,staged/'npm-cache')
        for p in sorted((staged/'npm-cache').rglob('*'),reverse=True):
            if p.is_dir():sync(p)
        sync(staged/'npm-cache');sync(staged)
        for name in OPS[:2]:
            target=BASE/name
            if not os.path.lexists(target):write(target,raw(incoming/name,1024*1024),0o644)
        staged.rename(INPUT/sha);sync(INPUT)
        p=dict(schemaVersion=2,sha=sha,cacheManifestSha256=m['cacheManifestSha256'],bundleSha256=m['sourceBundleSha256'],signerFingerprint=args.signer,expiresAt=time.time()+args.lease_seconds)
        write(POLICY,(json.dumps(p,sort_keys=True)+'\n').encode());sync(BASE)
        return dict(status='M7_ADMIN_PROVISION_PASS',sourceSHA=sha,capsuleSha256=args.capsule_sha,activationEligible=False,productionBrokerChanged=False)
    finally:
        # Only this invocation's root-private staging directory.
        shutil.rmtree(work)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--sha',required=True);ap.add_argument('--capsule-sha',required=True)
    ap.add_argument('--admission-sha',required=True);ap.add_argument('--launcher-sha',required=True);ap.add_argument('--provision-sha',required=True)
    ap.add_argument('--signer',required=True);ap.add_argument('--lease-seconds',type=int,default=3600)
    ap.add_argument('--accept',action='store_true',help='Explicit isolated admission; never activates')
    a=ap.parse_args()
    if os.geteuid()!=0:raise SystemExit('PROVISION_ROOT_REQUIRED')
    if not SHA.fullmatch(a.sha) or not all(DIGEST.fullmatch(x) for x in (a.capsule_sha,a.admission_sha,a.launcher_sha,a.provision_sha)) or not re.fullmatch('SHA256:[A-Za-z0-9+/]{43}',a.signer) or not 900<=a.lease_seconds<=7200:
        raise SystemExit('PROVISION_EXACT_PINS_REQUIRED')
    protect(BASE,True);protect(Path(__file__))
    lock=protect(BASE/'broker.lock')
    with lock.open('rb') as f:
        fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
        before=snapshot()
        result=provision(a)
        if snapshot()!=before:raise RuntimeError('PROVISION_PRODUCTION_DRIFT')
        print(json.dumps(result),flush=True)
        if a.accept:
            operator=protect(BASE/'premerge-admission.py')
            if digest(raw(operator,1024*1024))!=a.admission_sha:raise RuntimeError('PROVISION_OPERATOR_DRIFT')
            run=subprocess.run(['/usr/bin/python3','-I','-B',str(operator),'--sha',a.sha],env=ENV,capture_output=True,text=True,timeout=1200)
            if snapshot()!=before:raise RuntimeError('PROVISION_PRODUCTION_DRIFT')
            if run.returncode:raise RuntimeError('PROVISION_ISOLATED_ACCEPTANCE_FAILED:'+run.stderr[-4096:])
            receipt=json.loads(run.stdout)
            if receipt.get('status')!='RELEASE_PREMERGE_ACCEPTANCE_PASS' or receipt.get('sourceSHA')!=a.sha or receipt.get('activationEligible') is not False or receipt.get('productionChanged') is not False:raise RuntimeError('PROVISION_RECEIPT_INVALID')
            print(json.dumps(receipt),flush=True)

if __name__=='__main__':main()
