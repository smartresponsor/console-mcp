#!/usr/bin/python3
"""Copy independently admitted Browsing bytes into an immutable pair-specific store.

Evidence-only sealing, no service changes or policy grant. Console must already
be sealed by the existing canonical release controller. No rebuild here.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import stat
import sys
import tempfile

BASE=Path('/opt/console-mcp-deploy')
SHA=re.compile('[a-f0-9]{40}')
PIN=re.compile('[a-f0-9]{64}')
RUN=re.compile('m7-[a-f0-9]{8}')
PROVISION='4b59e9d55b288430df3453800b651a8f55795078eb7fd9e59c69fe1734421246'

def require(ok,msg):
    if not ok:raise ValueError(msg)

def digest(raw):return hashlib.sha256(raw).hexdigest()

def unique(pairs):
    out={}
    for k,v in pairs:
        require(k not in out,'SEAL_DUPLICATE_KEY')
        out[k]=v
    return out

def decode(raw):return json.loads(raw,object_pairs_hook=unique)

def protected(path,uid=0,directory=False):
    s=path.lstat()
    require(s.st_uid==uid and not s.st_mode&0o022,'SEAL_UNPROTECTED:'+str(path))
    require(stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode) and s.st_nlink==1,'SEAL_MEMBER_TYPE:'+str(path))
    return s

def chain(path):
    for p in reversed(path.parents):protected(p,0,True)
    protected(path,0,True)

def stamp(s):return (s.st_dev,s.st_ino,s.st_uid,s.st_mode,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)

def read(path,uid=0,limit=128*1024**2):
    s=protected(path,uid)
    require(s.st_size<=limit,'SEAL_FILE_LIMIT')
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as f:
        require(stamp(os.fstat(f.fileno()))==stamp(s),'SEAL_FILE_RACE')
        raw=f.read(limit+1)
        require(len(raw)==s.st_size and stamp(os.fstat(f.fileno()))==stamp(s)==stamp(path.lstat()),'SEAL_FILE_DRIFT')
    return raw

def sync(path):
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)

def write(path,raw,mode=0o644):
    with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode),'wb') as f:
        os.fchmod(f.fileno(),mode);f.write(raw);f.flush();os.fsync(f.fileno())

def ensure_dir(path,uid):
    if not os.path.lexists(path):
        path.mkdir(mode=0o755);path.chmod(0o755);sync(path.parent)
    protected(path,uid,True)

def evidence(run,sha,receipt_pin,inventory_pin,cleanup_pin,uid,verify):
    protected(run,uid,True)
    rr=read(run/'browsing-receipt.json',uid,65536)
    ir=read(run/'browsing-inventory.json',uid,32*1024**2)
    cr=read(run/'cleanup.json',uid,1024**2)
    require(digest(rr)==receipt_pin and digest(ir)==inventory_pin and digest(cr)==cleanup_pin,'SEAL_EVIDENCE_PIN')
    r,i,c=map(decode,(rr,ir,cr))
    tree=run/'artifact'/'dist'
    protected(run/'artifact',uid,True);protected(tree,uid,True)
    require(r.get('status')=='BROWSING_LINUX_INDEPENDENT_BUILD_PASS' and r.get('sourceSHA')==sha and r.get('runId')==run.name and r.get('artifactPath')==str(tree) and r.get('inventorySha256')==inventory_pin and r.get('cleanupSha256')==cleanup_pin and r.get('buildMode')=='offline-bwrap' and r.get('lifecycleScripts') is False and r.get('activationEligible') is False and r.get('productionChanged') is False,'SEAL_RECEIPT_IDENTITY')
    require(c.get('status')=='BROWSING_BUILD_CLEANUP_PASS' and c.get('before') is not None and c.get('before')==c.get('after') and c.get('failures')==[] and c.get('errorType') is None and c.get('activationEligible') is False and isinstance(c.get('cleanedUnits'),list) and bool(c['cleanedUnits']),'SEAL_CLEANUP_IDENTITY')
    require(type(i) is dict and len(i)==r.get('fileCount') and 0<len(i)<=50000 and all(type(k) is str and all(n not in ('','.','..') for n in k.split('/')) and k!='release.json' and type(v) is str and PIN.fullmatch(v) for k,v in i.items()),'SEAL_INVENTORY_SCHEMA')
    require(not os.path.lexists(tree/'release.json') and verify['inventory'](tree,uid)==i,'SEAL_EVIDENCE_DRIFT')
    locks=verify['LOCKFILES']
    require(r.get('lockfiles')=={k:i.get(k) for k in locks} and all(k in i for k in (*locks,verify['WORKER'],'.source-inventory.json')),'SEAL_LOCKFILES')
    return tree,i,r

def seal(console,console_sha,console_pin,run,browsing_sha,receipt_pin,inventory_pin,cleanup_pin,store,uid,verify):
    require(SHA.fullmatch(console_sha) and SHA.fullmatch(browsing_sha),'SEAL_SHA')
    c=verify['verify_tree'](console,console_sha,console_pin,uid)
    cf=c['files']
    require(all(type(cf.get(k)) is str and PIN.fullmatch(cf[k]) for k in (verify['LOCK'],verify['SESSION'],'package-lock.json')) and c.get('lockfileSha256')==cf['package-lock.json'],'SEAL_CONSOLE_MEMBERS')
    tree,files,r=evidence(run,browsing_sha,receipt_pin,inventory_pin,cleanup_pin,uid,verify)
    manifest=dict(schemaVersion=2,sourceCommit=browsing_sha,files=files,
        lockfiles=r['lockfiles'],console=dict(sourceCommit=console_sha,manifestSha256=console_pin,
        leaseModuleSha256=cf[verify['LOCK']],sessionModuleSha256=cf[verify['SESSION']]),
        buildEvidence=dict(runId=run.name,receiptSha256=receipt_pin,inventorySha256=inventory_pin,cleanupSha256=cleanup_pin))
    raw=(json.dumps(manifest,sort_keys=True)+'\n').encode();pin=digest(raw)
    protected(store,uid,True);parent=store/console_sha
    ensure_dir(parent,uid);target=parent/browsing_sha
    if os.path.lexists(target):
        verify['verify_pair'](console,target,console_sha,browsing_sha,console_pin,pin,uid)
        return dict(status='BROWSING_PAIR_SEAL_PASS',reused=True,browsingManifestSha256=pin,releasePath=str(target),activationEligible=False)
    staging=Path(tempfile.mkdtemp(prefix='.pair-stage-',dir=parent));staging.chmod(0o700)
    stage=staging/browsing_sha;stage.mkdir(mode=0o755);stage.chmod(0o755)
    for name,expected in sorted(files.items()):
        src=tree/name;dest=stage/name
        for p in reversed(dest.parents):
            if p==stage or stage in p.parents:ensure_dir(p,uid)
        data=read(src,uid)
        require(digest(data)==expected,'SEAL_COPY_DRIFT:'+name)
        write(dest,data)
    write(stage/'release.json',raw)
    verify['verify_pair'](console,stage,console_sha,browsing_sha,console_pin,pin,uid)
    for directory in sorted((p for p in stage.rglob('*') if p.is_dir()),key=lambda p:len(p.parts),reverse=True):sync(directory)
    sync(stage);sync(staging)
    require(not os.path.lexists(target),'SEAL_TARGET_EXISTS')
    stage.rename(target);sync(parent);staging.rmdir();sync(parent)
    verify['verify_pair'](console,target,console_sha,browsing_sha,console_pin,pin,uid)
    return dict(status='BROWSING_PAIR_SEAL_PASS',reused=False,browsingManifestSha256=pin,releasePath=str(target),activationEligible=False)

def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('console-sha','console-manifest-sha','browsing-sha','run-id','receipt-sha','inventory-sha','cleanup-sha','verifier-sha','selector-sha'):p.add_argument('--'+name,required=True)
    args=p.parse_args()
    require(sys.flags.isolated and os.getuid()==os.geteuid()==0,'SEAL_ADMIN_REQUIRED')
    require(all(SHA.fullmatch(x) for x in (args.console_sha,args.browsing_sha)) and RUN.fullmatch(args.run_id) and all(PIN.fullmatch(x) for x in (args.console_manifest_sha,args.receipt_sha,args.inventory_sha,args.cleanup_sha,args.verifier_sha,args.selector_sha)),'SEAL_EXACT_PINS_REQUIRED')
    chain(BASE)
    own=Path(__file__).absolute();chain(own.parent);protected(own)
    verifier=BASE/'browsing-pair-admission.py';selector=BASE/'release-store-selector.py';provision=BASE/'premerge-provision.py'
    for path,pin in ((verifier,args.verifier_sha),(selector,args.selector_sha),(provision,PROVISION)):
        require(digest(read(path,0,1024**2))==pin,'SEAL_OPERATOR_PIN')
    v=runpy.run_path(str(verifier),run_name='pair_seal_verifier')
    root=runpy.run_path(str(selector),run_name='pair_seal_store')['store'](BASE)
    helper=runpy.run_path(str(provision),run_name='pair_seal_continuity')
    console=root/args.console_sha;run=BASE/'premerge-evidence'/args.run_id
    chain(console);chain(run)
    for path in (BASE/'broker.lock',BASE/'lock'):protected(path)
    with (BASE/'broker.lock').open('rb') as lock,(BASE/'lock').open('rb') as deploy_lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);fcntl.flock(deploy_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        before=helper['snapshot']()
        try:
            store=BASE/'browsing-releases'
            evidence(run,args.browsing_sha,args.receipt_sha,args.inventory_sha,args.cleanup_sha,0,v)
            v['verify_tree'](console,args.console_sha,args.console_manifest_sha,0)
            ensure_dir(store,0)
            result=seal(console,args.console_sha,args.console_manifest_sha,run,args.browsing_sha,args.receipt_sha,args.inventory_sha,args.cleanup_sha,store,0,v)
        finally:require(helper['snapshot']()==before,'SEAL_PRODUCTION_CONTINUITY')
    print(json.dumps(dict(result,consoleSHA=args.console_sha,browsingSHA=args.browsing_sha,consoleManifestSha256=args.console_manifest_sha,productionChanged=False,policyChanged=False)))

if __name__=='__main__':main()
