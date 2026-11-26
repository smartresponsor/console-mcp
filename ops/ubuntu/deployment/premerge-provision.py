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
import signal
import stat
import subprocess
import tempfile
import time
import uuid

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
    if not os.path.lexists(p):
        p.mkdir(mode=0o700);p.chmod(0o700)
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

def process_identity(pid):
    if not re.fullmatch('[1-9][0-9]*',str(pid)):raise ValueError('PROVISION_PID')
    boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    if not re.fullmatch('[0-9a-f-]{36}',boot):raise ValueError('PROVISION_BOOT_ID')
    fields=Path('/proc')/str(pid)/'stat'
    text=fields.read_text();end=text.rfind(')')
    if end<0 or text.split(' ',1)[0]!=str(pid):raise ValueError('PROVISION_PID_STAT')
    start=text[end+2:].split()[19]
    if not start.isdecimal():raise ValueError('PROVISION_PID_START')
    return {'bootId':boot,'pid':str(pid),'startTicks':start}

def snapshot():
    r=raw(BASE/'registry.json',1024*1024)
    journal=BASE/'transaction.json'
    def runtime():
        state=subprocess.check_output(['/usr/bin/systemctl','show','console-mcp.service','-p','MainPID','-p','ActiveState','-p','BindReadOnlyPaths'],env=ENV,text=True,timeout=10)
        fields=dict(line.split('=',1) for line in state.splitlines() if '=' in line)
        if fields.get('ActiveState')!='active' or not re.fullmatch('[1-9][0-9]*',fields.get('MainPID','')) or not fields.get('BindReadOnlyPaths'):raise RuntimeError('PROVISION_RUNTIME_UNKNOWN')
        return fields
    fields=runtime()
    selected=json.loads(r,object_pairs_hook=unique)
    loaded=[]
    for binding in fields['BindReadOnlyPaths'].split():
        parts=binding.split(':')
        if len(parts)>=2 and parts[1]=='/home/alex/smartresponse/mcp/console-mcp/dist':loaded.append(Path(parts[0]).parent.name)
    if len(loaded)!=1 or not SHA.fullmatch(loaded[0]) or selected.get('candidate')!=loaded[0]:raise RuntimeError('PROVISION_LOADED_RELEASE_UNKNOWN')
    identity=process_identity(fields['MainPID'])
    result={'registrySha256':digest(r),'transactionSha256':digest(raw(journal,1024*1024)) if journal.exists() else None,'runtime':fields,'processIdentity':identity,'loadedRelease':loaded[0],
            'brokerSha256':digest(raw(BASE/'release-broker.py',1024*1024)),'brokerPolicySha256':digest(raw(BASE/'broker-policy.json',1024*1024))}
    if runtime()!=fields or process_identity(fields['MainPID'])!=identity or digest(raw(BASE/'registry.json',1024*1024))!=result['registrySha256'] or (digest(raw(journal,1024*1024)) if journal.exists() else None)!=result['transactionSha256']:raise RuntimeError('PROVISION_RUNTIME_RACE')
    return result

def atomic_json(path,value,replace=False):
    # Root-private directory, serialized by existing broker lock.
    protect(path.parent,True)
    tmp=path.parent/('.write-'+uuid.uuid4().hex)
    try:
        write(tmp,(json.dumps(value,sort_keys=True)+'\n').encode())
        if replace:
            protect(path);os.replace(tmp,path)
        else:
            if os.path.lexists(path):raise FileExistsError('PROVISION_JOURNAL_EXISTS')
            os.rename(tmp,path)
        sync(path.parent)
    finally:
        if tmp.exists():tmp.unlink()

def publish_file(path,data,mode=0o600):
    tmp=path.parent/('.write-'+uuid.uuid4().hex)
    try:
        write(tmp,data,mode)
        if os.path.lexists(path):raise FileExistsError('PROVISION_OPERATOR_EXISTS')
        os.rename(tmp,path);sync(path.parent)
    finally:
        if tmp.exists():tmp.unlink()

def policy_identity(m):
    return dict(schemaVersion=3,sha=m['sourceSHA'],cacheManifestSha256=m['cacheManifestSha256'],bundleSha256=m['sourceBundleSha256'],signerFingerprint=m['signerFingerprint'],lockfileSha256=m['lockfileSha256'],operators=m['operators'])

def verify_inputs(path,m,expected):
    protect(path,True)
    if {p.name for p in path.iterdir()}!={'source.bundle','npm-cache.json','npm-cache'}:raise ValueError('PROVISION_INPUT_MEMBERS')
    if digest(raw(path/'source.bundle'))!=m['sourceBundleSha256'] or digest(raw(path/'npm-cache.json',16*1024*1024))!=m['cacheManifestSha256']:raise ValueError('PROVISION_INPUT_PIN')
    cache_inventory(path/'npm-cache',expected)

def provision(args,m,incoming,journal):
    sha=args.sha;approved=m['operators'];expected=read_json(incoming/'npm-cache.json')
    cache_inventory(incoming/'npm-cache',expected)
    ensure_dir(INPUT);ensure_dir(EVIDENCE)
    for name in OPS[:2]:
        target=BASE/name
        if os.path.lexists(target):
            if digest(raw(target,1024*1024))!=approved[name]:raise FileExistsError('PROVISION_OPERATOR_EXISTS')
        else:publish_file(target,raw(incoming/name,1024*1024),0o644)
    target=INPUT/sha
    if not os.path.lexists(target):
        work=Path(tempfile.mkdtemp(prefix='.provision-',dir=INPUT));work.chmod(0o700)
        try:
            staged=work/'inputs';staged.mkdir(mode=0o700)
            (staged/'npm-cache').mkdir(mode=0o700)
            write(staged/'source.bundle',raw(incoming/'source.bundle'))
            write(staged/'npm-cache.json',raw(incoming/'npm-cache.json'))
            cache_inventory(incoming/'npm-cache',expected,staged/'npm-cache')
            for p in sorted((staged/'npm-cache').rglob('*'),reverse=True):
                if p.is_dir():sync(p)
            sync(staged/'npm-cache');sync(staged)
            verify_inputs(staged,m,expected)
            staged.rename(target);sync(INPUT)
        finally:shutil.rmtree(work)
    verify_inputs(target,m,expected)
    policy=dict(policy_identity(m),expiresAt=journal['policyExpiresAt'])
    if os.path.lexists(POLICY):
        existing=read_json(POLICY)
        previous=dict(policy_identity(m),expiresAt=journal['priorPolicyExpiresAt'])
        if existing!=policy and (journal['priorPolicyExpiresAt'] is None or existing!=previous):
            raise FileExistsError('PROVISION_POLICY_DIVERGED')
        if existing!=policy:atomic_json(POLICY,policy,replace=True)
    else:atomic_json(POLICY,policy)
    return dict(status='M7_ADMIN_PROVISION_PASS',sourceSHA=sha,capsuleSha256=args.capsule_sha,activationEligible=False,productionBrokerChanged=False)

def cleanup_run(run_id):
    if run_id is None:return []
    if not re.fullmatch(r'm7-[0-9a-f]{8}',run_id):raise ValueError('PROVISION_RUN_ID')
    run=EVIDENCE/run_id
    if not os.path.lexists(run):return []
    protect(run,True)
    cleaned=[];errors=[]
    for marker in sorted(run.glob('unit-*')):
        name=marker.name[5:]
        try:
            protect(marker)
            if not re.fullmatch(r'cmcp-premerge-(?:source|build|proof)-[0-9a-f]{12}',name):raise ValueError('PROVISION_UNIT_MARKER')
            # Unit names are fixed, randomly generated and durably recorded.
            subprocess.run(['/usr/bin/systemctl','stop',name],env=ENV,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)
            res=subprocess.run(['/usr/bin/systemctl','show',name,'-p','LoadState','-p','ActiveState','-p','ControlGroup'],env=ENV,capture_output=True,text=True,timeout=10)
            fields=dict(x.split('=',1) for x in res.stdout.splitlines() if '=' in x)
            if fields.get('LoadState')!='not-found' and (res.returncode or fields.get('ActiveState') not in ('inactive','failed')):raise RuntimeError('PROVISION_CLEANUP_FAILED')
            cg=fields.get('ControlGroup') or '/system.slice/'+name+'.service'
            if cg!='/system.slice/'+name+'.service':raise RuntimeError('PROVISION_CGROUP_IDENTITY')
            events=Path('/sys/fs/cgroup')/cg.lstrip('/')/'cgroup.events'
            if events.exists() and 'populated 0' not in events.read_text().splitlines():raise RuntimeError('PROVISION_CGROUP_POPULATED')
            cleaned.append(name)
        except (OSError,ValueError,RuntimeError,subprocess.SubprocessError) as e:
            errors.append(name+':'+type(e).__name__)
    if errors:raise RuntimeError('PROVISION_CLEANUP_FAILED:'+','.join(errors))
    return cleaned

def journal_identity(args,m):
    return dict(sourceSHA=args.sha,capsuleSha256=args.capsule_sha,signerFingerprint=args.signer,operators=m['operators'],policy=policy_identity(m))

def finish_attempt(path,journal,before,run_id,error,receipt=None):
    # Finally-path: both checks attempted even when one fails.
    failures=[];cleaned=[];after=None
    try:cleaned=cleanup_run(run_id)
    except BaseException as e:failures.append('cleanup:'+type(e).__name__)
    try:after=snapshot()
    except BaseException as e:failures.append('continuity:'+type(e).__name__)
    if after!=before:failures.append('production_drift_or_unknown')
    result=dict(status='M7_ADMIN_ATTEMPT_PASS' if error is None and not failures else 'M7_ADMIN_ATTEMPT_FAILED',
                sourceSHA=journal['identity']['sourceSHA'],attempt=journal['attempt'],runId=run_id,
                before=before,after=after,cleanedUnits=cleaned,failures=failures,
                errorType=type(error).__name__ if error else None,acceptance=receipt if not failures and error is None else None,
                activationEligible=False,productionChanged=None if after is None else after!=before)
    receipt_path=path.parent/(path.stem+'-attempt-'+str(journal['attempt'])+'.json')
    # If interrupted after receipt publication, preserve the original receipt;
    # the caller can recover the terminal journal from that immutable evidence.
    if os.path.lexists(receipt_path):raise RuntimeError('PROVISION_ATTEMPT_RECEIPT_EXISTS')
    atomic_json(receipt_path,result)
    journal['phase']='blocked' if failures else ('accepted' if error is None and receipt is not None else 'provisioned' if error is None else 'failed')
    journal['receiptPath']=str(receipt_path)
    atomic_json(path,journal,replace=True)
    return result

def invoke_admission(operator,sha,run_id,lock_fd=None):
    command=['/usr/bin/python3','-I','-B',str(operator),'--sha',sha,'--run-id',run_id]
    # Child retains the broker flock's open file description if the provisioner
    # is killed. Resume cannot race a surviving controller. No candidate child
    # inherits this fd (all downstream subprocesses use close_fds).
    with subprocess.Popen(command,env=ENV,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True,pass_fds=() if lock_fd is None else (lock_fd,)) as proc:
        try:out,err=proc.communicate(timeout=1200)
        except BaseException:
            try:os.killpg(proc.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            proc.communicate(timeout=10);raise
        return subprocess.CompletedProcess(command,proc.returncode,out,err)

def administer(args,lock_fd=None):
    incoming=protect(INCOMING/args.sha,True)
    approved=dict(zip(OPS,(args.admission_sha,args.launcher_sha,args.provision_sha)))
    if digest(raw(Path(__file__)))!=approved['premerge-provision.py']:raise ValueError('PROVISION_SELF_PIN')
    m=validate_capsule(incoming,args.sha,args.capsule_sha,args.signer,approved)
    protect(SIGNERS)
    # Parsing the Git bundle is deliberately deferred to the independent
    # UID 993 source sandbox; root only hashes opaque bytes.
    journals=BASE/'premerge-journals';ensure_dir(journals)
    path=journals/(args.sha+'.json');identity=journal_identity(args,m)
    before=snapshot()
    if os.path.lexists(path):
        if not args.resume:raise FileExistsError('PROVISION_RESUME_REQUIRED')
        old=read_json(path)
        if old.get('identity')!=identity or old.get('phase') not in ('prepared','accepting','accepted','provisioned','failed','blocked') or type(old.get('attempt')) is not int or old['attempt']<1:raise ValueError('PROVISION_JOURNAL_IDENTITY')
        if old.get('phase')=='blocked':raise RuntimeError('PROVISION_MANUAL_REVIEW_REQUIRED')
        if old.get('phase')=='accepted':
            prior=path.parent/(path.stem+'-attempt-'+str(old['attempt'])+'.json')
            if old.get('receiptPath')!=str(prior):raise ValueError('PROVISION_RECEIPT_PATH')
            result=read_json(prior)
            if result.get('status')!='M7_ADMIN_ATTEMPT_PASS' or result.get('acceptance') is None or result.get('sourceSHA')!=args.sha or result.get('before')!=before or result.get('after')!=before:raise ValueError('PROVISION_ACCEPTED_RECEIPT')
            print(json.dumps(result),flush=True);return
        if old.get('phase') in ('prepared','accepting'):
            # Recover interruption before renewing a lease or starting another run.
            prior_receipt=path.parent/(path.stem+'-attempt-'+str(old['attempt'])+'.json')
            if os.path.lexists(prior_receipt):
                result=read_json(prior_receipt)
                if result.get('sourceSHA')!=args.sha or result.get('attempt')!=old['attempt'] or result.get('runId')!=old['runId'] or result.get('before')!=old['before'] or result.get('activationEligible') is not False:raise RuntimeError('PROVISION_RECOVERY_RECEIPT_IDENTITY')
                cleanup_run(old['runId'])
                if snapshot()!=old['before'] or result.get('failures') or result.get('after')!=old['before']:
                    old['phase']='blocked';atomic_json(path,old,replace=True);raise RuntimeError('PROVISION_MANUAL_REVIEW_REQUIRED')
                old['phase']='accepted' if result.get('acceptance') is not None and result.get('status')=='M7_ADMIN_ATTEMPT_PASS' else 'failed' if result.get('errorType') else 'provisioned'
                old['receiptPath']=str(prior_receipt);atomic_json(path,old,replace=True)
                if old['phase']=='accepted':print(json.dumps(result),flush=True);return
            else:
                result=finish_attempt(path,old,old['before'],old['runId'],RuntimeError('PROVISION_INTERRUPTED'))
                if result['failures']:raise RuntimeError('PROVISION_MANUAL_REVIEW_REQUIRED')
        expiry=old['policyExpiresAt'];attempt=old['attempt']+1
        # The previous intended policy may not have been published yet.
        existing=read_json(POLICY) if os.path.lexists(POLICY) else None
        if existing is not None:
            actual=existing.get('expiresAt')
            if existing!=dict(policy_identity(m),expiresAt=actual) or actual not in (expiry,old.get('priorPolicyExpiresAt')):raise RuntimeError('PROVISION_POLICY_DIVERGED')
            expiry=actual
    else:
        if args.resume:raise ValueError('PROVISION_NO_JOURNAL')
        if os.path.lexists(POLICY) or os.path.lexists(INPUT/args.sha):raise FileExistsError('PROVISION_EXISTING_STATE')
        expiry=None;attempt=1
    run_id='m7-'+uuid.uuid4().hex[:8] if args.accept else None
    journal=dict(identity=identity,phase='prepared',attempt=attempt,before=before,runId=run_id,
                 priorPolicyExpiresAt=expiry,policyExpiresAt=time.time()+args.lease_seconds)
    atomic_json(path,journal,replace=os.path.lexists(path))
    error=None;receipt=None
    try:
        result=provision(args,m,incoming,journal)
        print(json.dumps(result),flush=True)
        if args.accept:
            journal['phase']='accepting';atomic_json(path,journal,replace=True)
            operator=protect(BASE/'premerge-admission.py')
            if digest(raw(operator,1024*1024))!=args.admission_sha:raise RuntimeError('PROVISION_OPERATOR_DRIFT')
            run=invoke_admission(operator,args.sha,run_id,lock_fd)
            if run.returncode:raise RuntimeError('PROVISION_ISOLATED_ACCEPTANCE_FAILED:'+run.stderr[-4096:])
            receipt=json.loads(run.stdout,object_pairs_hook=unique)
            if receipt.get('status')!='RELEASE_PREMERGE_ACCEPTANCE_PASS' or receipt.get('sourceSHA')!=args.sha or receipt.get('activationEligible') is not False or receipt.get('productionChanged') is not False or receipt.get('proof',{}).get('expectedBaselineVerified') is not True:raise RuntimeError('PROVISION_RECEIPT_INVALID')
    except BaseException as e:
        error=e
        raise
    finally:
        final=finish_attempt(path,journal,before,run_id,error,receipt)
        print(json.dumps(final),flush=True)
        if final['failures']:raise RuntimeError('PROVISION_MANUAL_REVIEW_REQUIRED')

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--sha',required=True);ap.add_argument('--capsule-sha',required=True)
    ap.add_argument('--admission-sha',required=True);ap.add_argument('--launcher-sha',required=True);ap.add_argument('--provision-sha',required=True)
    ap.add_argument('--signer',required=True);ap.add_argument('--lease-seconds',type=int,default=3600)
    ap.add_argument('--accept',action='store_true',help='Explicit isolated admission; never activates')
    ap.add_argument('--resume',action='store_true',help='Resume exact prior journal; never overwrite unrelated state')
    a=ap.parse_args()
    if os.geteuid()!=0:raise SystemExit('PROVISION_ROOT_REQUIRED')
    if not SHA.fullmatch(a.sha) or not all(DIGEST.fullmatch(x) for x in (a.capsule_sha,a.admission_sha,a.launcher_sha,a.provision_sha)) or not re.fullmatch('SHA256:[A-Za-z0-9+/]{43}',a.signer) or not 900<=a.lease_seconds<=7200:
        raise SystemExit('PROVISION_EXACT_PINS_REQUIRED')
    protect(BASE,True);protect(Path(__file__))
    lock=protect(BASE/'broker.lock')
    with lock.open('rb') as f:
        fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
        administer(a,f.fileno())

if __name__=='__main__':main()
