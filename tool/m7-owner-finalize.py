#!/usr/bin/python3
"""Owner-side M7 signed commit and exact Git bundle/capsule. Never escalates."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile

ROOT=Path(__file__).resolve().parent.parent
BASE='d5291f139f04c0efbd8d5fd271221a180a7b12bc'
BRANCH='integration/engine-preservation-cce0f77'
SIGNER='SHA256:Bt2B2CF6uL5A9VwIjUkPfzIr48lT0Eqv5rvo2Oj4rWo'
FILES=(
 'docs/m7-premerge-admission.md','ops/ubuntu/deployment/premerge-bwrap-launcher.py',
 'tool/m7-premerge-regression.py','tool/m7-owner-finalize.py',
)
OPS=('premerge-admission.py','premerge-bwrap-launcher.py','premerge-provision.py')
ENV={'PATH':'/usr/bin:/bin','HOME':str(Path.home()),'LC_ALL':'C','GIT_NO_REPLACE_OBJECTS':'1','GIT_TERMINAL_PROMPT':'0'}

def g(*args):
    return subprocess.check_output(['/usr/bin/git','-C',str(ROOT),*args],env=ENV,timeout=180)

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def write(path,raw):
    with path.open('xb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
    path.chmod(0o600)

def verify_cache(path,lock):
    r=json.loads((path/'cache-receipt.json').read_bytes())
    manifest=json.loads((path/'npm-cache.json').read_bytes())
    assert r['status']=='M7_MINIMAL_OFFLINE_CACHE_PASS' and r['offlineCi'] is True and r['lockfileSha256']==lock
    assert sha(path/'npm-cache.json')==r['cacheManifestSha256']
    actual={}
    for p in (path/'npm-cache').rglob('*'):
        s=p.lstat()
        if stat.S_ISDIR(s.st_mode):continue
        assert stat.S_ISREG(s.st_mode) and s.st_nlink==1
        actual[p.relative_to(path/'npm-cache').as_posix()]=sha(p)
    assert actual==manifest
    return r

def reviewed_inventory(reader):
    values={n:hashlib.sha256(reader(n)).hexdigest() for n in sorted(FILES)}
    return hashlib.sha256(json.dumps(values,sort_keys=True,separators=(',',':')).encode()).hexdigest(),values

def main():
    p=argparse.ArgumentParser();p.add_argument('--cache',type=Path);p.add_argument('--cache-manifest-sha');p.add_argument('--review-sha');p.add_argument('--review',action='store_true');p.add_argument('--commit',action='store_true');a=p.parse_args()
    if a.review:
        assert not a.commit and a.cache is None and a.review_sha is None and a.cache_manifest_sha is None
        pin,files=reviewed_inventory(lambda n:(ROOT/n).read_bytes())
        print(json.dumps(dict(status='M7_SOURCE_REVIEW_PIN',reviewSha256=pin,files=files)));return
    if os.getuid()!=1000:raise SystemExit('M7_OWNER_UID_REQUIRED')
    if a.cache is None or not a.cache_manifest_sha or not a.review_sha:raise SystemExit('M7_EXACT_PINS_REQUIRED')
    assert reviewed_inventory(lambda n:(ROOT/n).read_bytes())[0]==a.review_sha
    assert g('branch','--show-current').decode().strip()==BRANCH
    cache=a.cache.resolve(strict=True)
    assert cache.parent==ROOT and cache.name.startswith('.m7-cache-')
    lock=sha(ROOT/'package-lock.json');r=verify_cache(cache,lock)
    assert r['cacheManifestSha256']==a.cache_manifest_sha
    head=g('rev-parse','HEAD').decode().strip()
    if head==BASE:
        if not a.commit:raise SystemExit('M7_EXPLICIT_COMMIT_REQUIRED')
        assert not g('diff','--cached','--name-only')
        changes=set(g('diff','--name-only').decode().splitlines())
        assert changes<=set(FILES),changes
        g('diff','--check')
        subprocess.run(['/usr/bin/pwsh','-NoProfile','-File',str(ROOT/'tool/m7-premerge-regression.ps1')],cwd=ROOT,check=True,timeout=120)
        assert reviewed_inventory(lambda n:(ROOT/n).read_bytes())[0]==a.review_sha
        g('add','--',*FILES)
        assert reviewed_inventory(lambda n:g('show',':'+n))[0]==a.review_sha
        assert set(g('diff','--cached','--name-only').decode().splitlines())==set(FILES)
        g('diff','--cached','--check')
        print(g('-c','gpg.format=ssh','-c','user.signingkey='+str(Path.home()/'.ssh/id_ed25519_git_signing'),'-c','commit.gpgsign=true','commit','-S','-m','fix(release): make sandbox traversal permissions explicit').decode(),flush=True)
        head=g('rev-parse','HEAD').decode().strip()
    else:
        assert g('rev-parse',head+'^').decode().strip()==BASE
        assert set(g('diff-tree','--no-commit-id','--name-only','-r',head).decode().splitlines())==set(FILES)
    assert not g('diff','HEAD','--name-only') and not g('diff','--cached','--name-only')
    assert reviewed_inventory(lambda n:g('show',head+':'+n))[0]==a.review_sha
    g('verify-commit',head)
    assert g('show','-s','--format=%G?%n%GF',head).decode().strip().splitlines()==['G',SIGNER]
    assert hashlib.sha256(g('show',head+':package-lock.json')).hexdigest()==lock
    common=Path(g('rev-parse','--git-common-dir').decode().strip())
    if not common.is_absolute():common=(ROOT/common).resolve()
    signers=common/'cmcp-allowed-signers'
    assert signers.is_file()
    stage=Path(tempfile.mkdtemp(prefix='m7-capsule-',dir=Path.home()));stage.chmod(0o700)
    bare=stage/'source.git'
    def b(*args):
        return subprocess.check_output(['/usr/bin/git','-c','core.hooksPath=/dev/null','-c','gpg.format=ssh','-c','gpg.ssh.allowedSignersFile='+str(signers),'--git-dir='+str(bare),*args],env=ENV,timeout=180)
    subprocess.run(['/usr/bin/git','init','--bare','--template=',str(bare)],env=ENV,check=True,stdout=subprocess.DEVNULL)
    b('fetch','--no-tags','--no-write-fetch-head',str(ROOT),'refs/heads/'+BRANCH+':refs/heads/premerge')
    assert b('rev-parse','refs/heads/premerge').decode().strip()==head
    b('verify-commit',head)
    b('bundle','create',str(stage/'source.bundle'),'refs/heads/premerge')
    b('bundle','verify',str(stage/'source.bundle'))
    (stage/'source.bundle').chmod(0o600)
    # Only verified cache content, not npm config, logs, or offline-check.
    shutil.copytree(cache/'npm-cache',stage/'npm-cache',symlinks=True)
    write(stage/'npm-cache.json',(cache/'npm-cache.json').read_bytes())
    verify_cache(cache,lock)
    for name in OPS:write(stage/name,g('show',head+':ops/ubuntu/deployment/'+name))
    actual={}
    for q in (stage/'npm-cache').rglob('*'):
        s=q.lstat()
        if stat.S_ISDIR(s.st_mode):continue
        assert stat.S_ISREG(s.st_mode) and s.st_nlink==1
        actual[q.relative_to(stage/'npm-cache').as_posix()]=sha(q)
    assert actual==json.loads((stage/'npm-cache.json').read_bytes())
    # The temporary bare repository is never part of the capsule.
    shutil.rmtree(bare)
    manifest={'schemaVersion':1,'sourceSHA':head,'signerFingerprint':SIGNER,'lockfileSha256':lock,
              'sourceBundleSha256':sha(stage/'source.bundle'),'cacheManifestSha256':sha(stage/'npm-cache.json'),
              'operators':{n:sha(stage/n) for n in OPS}}
    write(stage/'capsule.json',(json.dumps(manifest,sort_keys=True)+'\n').encode())
    print(json.dumps(dict(status='M7_SIGNED_CAPSULE_PASS',directory=str(stage),capsuleSha256=sha(stage/'capsule.json'),**manifest)),flush=True)

if __name__=='__main__':main()
