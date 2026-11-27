#!/usr/bin/python3
"""Evidence-only Browsing build using the installed M7 isolation operators.

Root caller must install/review this exact operator first. No new broker,
release policy changes, canonical merges, or production activation.
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
import subprocess
import uuid

BASE=Path('/opt/console-mcp-deploy')
CAP_ROOT=Path('/home/alex/smartresponse/mcp')
OPS={
 'premerge-admission.py':'4c05cf8122dc945e1e7f86446cc26eebf23c6a70dafdfaad1bfd47380459cf1e',
 'premerge-bwrap-launcher.py':'9467f3a39a9d746d0beaf5ce652c252791d8b7f8b268e6a2a6d2e214dab76794',
 'premerge-provision.py':'4b59e9d55b288430df3453800b651a8f55795078eb7fd9e59c69fe1734421246'}
SIGNERS='34143d3a95f7c4fdcb4725ad73e64b5801a20dd2ffae4bfdc87bb20d94d14bcc'
SIGNER='SHA256:Bt2B2CF6uL5A9VwIjUkPfzIr48lT0Eqv5rvo2Oj4rWo'
LOCKS=('mcp-server/package-lock.json','playwright-worker/package-lock.json')
D=os.O_DIRECTORY|os.O_NOFOLLOW|os.O_RDONLY
HEX=re.compile('[a-f0-9]{64}')
SHA=re.compile('[a-f0-9]{40}')

def require(ok,reason):
    if not ok:raise ValueError(reason)
def h(raw):return hashlib.sha256(raw).hexdigest()
def unique(pairs):
    d={}
    for k,v in pairs:
        require(k not in d,'BROWSING_DUPLICATE_KEY');d[k]=v
    return d
def decode(raw):return json.loads(raw,object_pairs_hook=unique)
def stamp(s):return (s.st_dev,s.st_ino,s.st_uid,s.st_mode,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
def read_fd(fd,name,uid,limit):
    with os.fdopen(os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd),'rb') as f:
        a=os.fstat(f.fileno())
        require(stat.S_ISREG(a.st_mode) and a.st_uid==uid and a.st_nlink==1 and not a.st_mode&0o022 and a.st_size<=limit,'BROWSING_CAPSULE_MEMBER')
        raw=f.read(limit+1)
        require(len(raw)==a.st_size and stamp(a)==stamp(os.fstat(f.fileno()))==stamp(os.stat(name,dir_fd=fd,follow_symlinks=False)),'BROWSING_CAPSULE_DRIFT')
        return raw
def write(path,raw,mode=0o600):
    with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode),'wb') as f:
        f.write(raw);f.flush();os.fsync(f.fileno())
def sync(path):
    fd=os.open(path,D)
    try:os.fsync(fd)
    finally:os.close(fd)
def open_absolute(path):
    fd=os.open('/',D)
    try:
        parts=path.parts[1:]
        for i,name in enumerate(parts):
            flags=D if i==len(parts)-1 else os.O_PATH|os.O_DIRECTORY|os.O_NOFOLLOW
            nxt=os.open(name,flags,dir_fd=fd);os.close(fd);fd=nxt
        return fd
    except BaseException:
        os.close(fd);raise
def parse_capsule(raw,sha,pin):
    require(h(raw)==pin,'BROWSING_CAPSULE_PIN')
    m=decode(raw)
    require(type(m) is dict and set(m)=={'schemaVersion','sourceSHA','signerFingerprint','sourceBundleSha256','cacheManifestSha256','lockfiles'} and type(m['schemaVersion']) is int and m['schemaVersion']==1 and m['sourceSHA']==sha and SHA.fullmatch(sha) and m['signerFingerprint']==SIGNER,'BROWSING_CAPSULE_IDENTITY')
    require(type(m['lockfiles']) is dict and set(m['lockfiles'])==set(LOCKS) and all(type(v) is str and HEX.fullmatch(v) for v in (*m['lockfiles'].values(),m['sourceBundleSha256'],m['cacheManifestSha256'])),'BROWSING_CAPSULE_PINS')
    return m
def import_capsule(src,run,sha,pin,uid=993):
    fd=open_absolute(src)
    try:
        st=os.fstat(fd)
        require(st.st_uid==uid and not st.st_mode&0o022 and set(os.listdir(fd))=={'capsule.json','source.bundle','npm-cache.json','npm-cache'},'BROWSING_CAPSULE_ROOT')
        raw=read_fd(fd,'capsule.json',uid,65536);m=parse_capsule(raw,sha,pin)
        bundle=read_fd(fd,'source.bundle',uid,64*1024*1024)
        cache=read_fd(fd,'npm-cache.json',uid,16*1024*1024)
        require(h(bundle)==m['sourceBundleSha256'] and h(cache)==m['cacheManifestSha256'],'BROWSING_CAPSULE_CONTENT_PIN')
        expected=decode(cache)
        require(type(expected) is dict and 0<len(expected)<=10000 and all(type(k) is str and k.startswith('_cacache/') and all(n not in ('','.','..') for n in k.split('/')) and type(v) is str and HEX.fullmatch(v) for k,v in expected.items()),'BROWSING_CACHE_MANIFEST')
        target=run/'artifact';target.mkdir(mode=0o700)
        write(target/'source.bundle',bundle);write(run/'capsule.json',raw);write(run/'npm-cache.json',cache)
        dest=run/'cache-input';dest.mkdir(mode=0o700)
        found={};total=0;entries=0
        def walk(dfd,out,prefix,depth):
            nonlocal total,entries
            before=os.fstat(dfd)
            require(before.st_uid==uid and not before.st_mode&0o022 and depth<=24,'BROWSING_CACHE_DIRECTORY')
            for name in sorted(os.listdir(dfd)):
                entries+=1;require(entries<=20000,'BROWSING_CACHE_LIMIT')
                p=prefix+name;st=os.stat(name,dir_fd=dfd,follow_symlinks=False)
                if stat.S_ISDIR(st.st_mode):
                    child=os.open(name,D,dir_fd=dfd)
                    try:
                        (out/name).mkdir(mode=0o700);walk(child,out/name,p+'/',depth+1)
                    finally:os.close(child)
                else:
                    require(p in expected,'BROWSING_CACHE_EXTRA')
                    data=read_fd(dfd,name,uid,64*1024*1024);total+=len(data)
                    require(total<=512*1024*1024 and h(data)==expected[p],'BROWSING_CACHE_PIN')
                    write(out/name,data);found[p]=expected[p]
            require(stamp(before)==stamp(os.fstat(dfd)),'BROWSING_CACHE_DRIFT');sync(out)
        cfd=os.open('npm-cache',D,dir_fd=fd)
        try:walk(cfd,dest,'',0)
        finally:os.close(cfd)
        require(found==expected and stamp(st)==stamp(os.fstat(fd)),'BROWSING_CACHE_INVENTORY')
        sync(target);sync(run)
        return m
    finally:os.close(fd)

# Fixed code invoked only in the existing build role. Git and npm never run
# as root. Output is limited to the launcher-imported regular dist tree.
BUILD=r'''import hashlib,json,os,re,subprocess,base64
from pathlib import Path
import sys
def need(ok,msg):
 if not ok:raise ValueError(msg)
def h(b):return hashlib.sha256(b).hexdigest()
need(os.getuid()==993 and os.geteuid()==993 and os.getpid()==1,'BROWSING_SANDBOX_REQUIRED')
m=json.loads(sys.argv[1]);signers=sys.argv[2];sha=m['sourceSHA']
work=Path('/work');repo=work/'source.git';dest=work/'dist'
need(h((work/'source.bundle').read_bytes())==m['sourceBundleSha256'] and h((work/'allowed-signers').read_bytes())==signers,'BROWSING_INPUT_DRIFT')
env={'PATH':'/usr/bin:/bin','HOME':'/nonexistent','LC_ALL':'C','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_NO_REPLACE_OBJECTS':'1','GIT_TERMINAL_PROMPT':'0','GIT_ALLOW_PROTOCOL':'file','GIT_OPTIONAL_LOCKS':'0'}
def g(*args):
 return subprocess.check_output(['/usr/bin/git','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','gpg.format=ssh','-c','gpg.ssh.program=/usr/bin/ssh-keygen','-c','gpg.ssh.allowedSignersFile=/work/allowed-signers','--git-dir='+str(repo),*args],env=env,timeout=90)
subprocess.run(['/usr/bin/git','init','--bare','--template=',str(repo)],env=env,check=True,stdout=subprocess.DEVNULL,timeout=10)
g('fetch','--no-tags','--no-write-fetch-head','/work/source.bundle','refs/heads/premerge:refs/heads/premerge')
need(g('rev-parse','refs/heads/premerge^{commit}').decode().strip()==sha,'BROWSING_SOURCE_SHA')
g('verify-commit',sha)
need(g('show','-s','--format=%G?%n%GF',sha).decode().strip().splitlines()==['G',m['signerFingerprint']],'BROWSING_SIGNATURE')
dest.mkdir(mode=0o700)
source={};total=0
for entry in g('ls-tree','-rz','--full-tree',sha,'--','mcp-server','playwright-worker','tool','package.json','package-lock.json').split(b'\0'):
 if not entry:continue
 meta,name=entry.split(b'\t',1);mode,kind,oid=meta.decode('ascii').split(' ');name=name.decode('utf8')
 parts=name.split('/')
 need(mode in ('100644','100755') and kind=='blob' and name not in source and all(x not in ('','.','..','node_modules','.git') for x in parts),'BROWSING_SOURCE_MEMBER')
 size=int(g('cat-file','-s',oid));total+=size
 need(len(source)<15000 and size<=16*1024**2 and total<=256*1024**2,'BROWSING_SOURCE_LIMIT')
 raw=g('cat-file','blob',oid);need(len(raw)==size,'BROWSING_SOURCE_SIZE')
 f=dest/name;f.parent.mkdir(parents=True,exist_ok=True);f.write_bytes(raw);source[name]=h(raw)
need('playwright-worker/src/worker.js' in source and all(source.get(n)==v for n,v in m['lockfiles'].items()),'BROWSING_LOCKFILE_PIN')
npm_env={'PATH':'/usr/bin:/bin','HOME':'/tmp','LC_ALL':'C','NODE_DISABLE_COMPILE_CACHE':'1','npm_config_userconfig':'/dev/null','npm_config_globalconfig':'/tmp/empty-global.npmrc','npm_config_registry':'https://registry.npmjs.org/','npm_config_ignore_scripts':'true','npm_config_offline':'true','npm_config_audit':'false','npm_config_fund':'false','npm_config_bin_links':'false'}
for part in ('mcp-server','playwright-worker'):
 lock=json.loads((dest/part/'package-lock.json').read_bytes())
 need(lock.get('lockfileVersion')==3 and type(lock.get('packages')) is dict,'BROWSING_LOCK_SCHEMA')
 for n,item in lock['packages'].items():
  if not n:continue
  need(type(item) is dict and not item.get('link') and re.fullmatch(r'sha512-[A-Za-z0-9+/]{86}==',item.get('integrity','')) and len(base64.b64decode(item['integrity'][7:],validate=True))==64 and re.fullmatch(r'https://registry\.npmjs\.org/[^?#]+',item.get('resolved','')),'BROWSING_UNPINNED_DEPENDENCY')
 subprocess.run(['/usr/bin/node','/usr/lib/node_modules/npm/bin/npm-cli.js','ci','--offline','--ignore-scripts','--no-bin-links','--no-audit','--no-fund','--cache','/cache'],cwd=dest/part,env=npm_env,check=True,timeout=180)
 need((dest/part/'node_modules').is_dir(),'BROWSING_DEPENDENCIES_MISSING')
for n,pin in source.items():need(h((dest/n).read_bytes())==pin,'BROWSING_SOURCE_DRIFT')
actual={p.relative_to(dest).as_posix() for p in dest.rglob('*') if p.is_file() and 'node_modules' not in p.relative_to(dest).parts}
need(actual==set(source),'BROWSING_SOURCE_EXTRA')
(dest/'.source-inventory.json').write_text(json.dumps(source,sort_keys=True)+'\n')
print('BROWSING_OFFLINE_BUILD_PASS')
'''

def check_artifact(tree,m,a):
    a['protected'](tree,True)
    source=a['read_json'](tree/'.source-inventory.json')
    require(type(source) is dict and source and all(type(v) is str and HEX.fullmatch(v) for v in source.values()),'BROWSING_SOURCE_INVENTORY')
    files=a['source_inventory'](tree)
    actual={n:v for n,v in files.items() if n!='.source-inventory.json' and 'node_modules' not in Path(n).parts}
    require(actual==source and all(actual.get(n)==v for n,v in m['lockfiles'].items()) and 'playwright-worker/src/worker.js' in actual,'BROWSING_BUILT_SOURCE_DRIFT')
    require(all(any(n.startswith(part+'/node_modules/') for n in files) for part in ('mcp-server','playwright-worker')),'BROWSING_BUILT_DEPENDENCIES')
    return files

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--sha',required=True);p.add_argument('--capsule-name',required=True);p.add_argument('--capsule-sha',required=True)
    args=p.parse_args()
    require(os.getuid()==os.geteuid()==0 and __import__('sys').flags.isolated,'BROWSING_ADMIN_REQUIRED')
    require(SHA.fullmatch(args.sha) and HEX.fullmatch(args.capsule_sha) and re.fullmatch(r'\.browsing-linux-capsule-[A-Za-z0-9]{6}',args.capsule_name),'BROWSING_EXACT_INPUT_REQUIRED')
    for path in (BASE,Path(__file__).absolute()):
        for ancestor in (*reversed(path.parents),path):
            st=ancestor.lstat();require(st.st_uid==0 and not st.st_mode&0o022 and not stat.S_ISLNK(st.st_mode),'BROWSING_ADMIN_PATH')
    # Verify all installed code as opaque bytes before importing any operator.
    for name,pin in OPS.items():
        path=BASE/name;st=path.lstat()
        require(stat.S_ISREG(st.st_mode) and st.st_uid==0 and st.st_nlink==1 and not st.st_mode&0o022 and h(path.read_bytes())==pin,'BROWSING_OPERATOR_PIN')
    a=runpy.run_path(str(BASE/'premerge-admission.py'),run_name='browsing_build_backend')
    helper=runpy.run_path(str(BASE/'premerge-provision.py'),run_name='browsing_build_continuity')
    require(a['digest'](BASE/'premerge-allowed-signers')==SIGNERS,'BROWSING_SIGNERS_PIN')
    a['require_isolation']()
    with a['protected'](BASE/'broker.lock').open('rb') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        before=helper['snapshot']();toolchain=a['toolchain_identity']()
        run=a['protected'](BASE/'premerge-evidence',True)/('m7-'+uuid.uuid4().hex[:8])
        run.mkdir(mode=0o700);run.chmod(0o700);sync(run.parent)
        error=None;receipt=None;failures=[];cleaned=[]
        try:
            m=import_capsule(CAP_ROOT/args.capsule_name,run,args.sha,args.capsule_sha)
            write(run/'artifact'/'allowed-signers',(BASE/'premerge-allowed-signers').read_bytes())
            (run/'private-build').mkdir(mode=0o700);(run/'private-build').chmod(0o700)
            name='cmcp-premerge-build-'+uuid.uuid4().hex[:12]
            try:
                result=a['unit'](name,run,'build',None,['/usr/bin/python3','-I','-B','-c',BUILD,json.dumps(m,sort_keys=True),SIGNERS],True)
                require(result.stdout.strip()=='PREMERGE_OFFLINE_BUILD_PASS','BROWSING_ISOLATED_BUILD_FAILED')
            finally:a['stop'](name)
            tree=run/'artifact'/'dist';files=check_artifact(tree,m,a)
            require(a['toolchain_identity']()==toolchain and a['digest'](BASE/'premerge-allowed-signers')==SIGNERS,'BROWSING_TOOLCHAIN_DRIFT')
            inventory=(json.dumps(files,sort_keys=True)+'\n').encode();write(run/'browsing-inventory.json',inventory)
            receipt=dict(status='BROWSING_LINUX_INDEPENDENT_BUILD_PASS',sourceSHA=args.sha,runId=run.name,capsuleSha256=args.capsule_sha,sourceBundleSha256=m['sourceBundleSha256'],cacheManifestSha256=m['cacheManifestSha256'],signerFingerprint=SIGNER,signersSha256=SIGNERS,lockfiles=m['lockfiles'],inventorySha256=h(inventory),fileCount=len(files),buildMode='offline-bwrap',lifecycleScripts=False,artifactPath=str(tree),toolchainEntrypoints=toolchain,activationEligible=False,productionChanged=False)
        except BaseException as exc:
            error=exc;raise
        finally:
            try:cleaned=helper['cleanup_run'](run.name)
            except BaseException as exc:failures.append('cleanup:'+type(exc).__name__)
            try:after=helper['snapshot']()
            except BaseException as exc:after=None;failures.append('continuity:'+type(exc).__name__)
            if after!=before:failures.append('production_drift')
            helper['atomic_json'](run/'cleanup.json',dict(status='BROWSING_BUILD_CLEANUP_PASS' if not failures else 'BROWSING_BUILD_CLEANUP_FAILED',before=before,after=after,cleanedUnits=cleaned,failures=failures,errorType=type(error).__name__ if error else None,activationEligible=False))
            require(not failures,'BROWSING_BUILD_CLEANUP_OR_CONTINUITY')
        receipt['cleanupSha256']=a['digest'](run/'cleanup.json')
        helper['atomic_json'](run/'browsing-receipt.json',receipt)
        print(json.dumps(dict(receipt,receiptPath=str(run/'browsing-receipt.json'))),flush=True)

if __name__=='__main__':main()
