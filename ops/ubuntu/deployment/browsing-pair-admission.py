"""Read-only pair verification for the existing Ubuntu release controller.

Not a sealer or an activation authority. The caller must supply independently
authorized exact manifest pins. No caller-selected production paths.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import stat

BASE = Path('/opt/console-mcp-deploy')
SHA = re.compile(r'[0-9a-f]{40}')
DIGEST = re.compile(r'[0-9a-f]{64}')
LOCK = 'dist/service/visible-browser-process-lock.js'
SESSION = 'dist/service/visible-browser-session.js'
WORKER = 'playwright-worker/src/worker.js'
LOCKFILES = ('mcp-server/package-lock.json','playwright-worker/package-lock.json')
MAX_FILES = 50000
MAX_BYTES = 2 * 1024**3

def require(ok, reason):
    if not ok:
        raise ValueError(reason)

def unique(pairs):
    out = {}
    for k,v in pairs:
        require(k not in out, 'PAIR_DUPLICATE_JSON_KEY')
        out[k] = v
    return out

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def hex_value(v, pattern):
    return isinstance(v,str) and pattern.fullmatch(v) is not None

def protected(path, uid, directory=False):
    s = path.lstat()
    require(s.st_uid == uid and not s.st_mode & 0o022, 'PAIR_UNPROTECTED:'+str(path))
    require(stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode) and s.st_nlink == 1,
            'PAIR_MEMBER_TYPE:'+str(path))
    return s

def stamp(s):
    return (s.st_dev,s.st_ino,s.st_uid,s.st_mode,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)

def read(path, uid, limit):
    before = protected(path,uid)
    require(before.st_size <= limit, 'PAIR_FILE_LIMIT')
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as f:
        require(stamp(os.fstat(f.fileno())) == stamp(before),'PAIR_FILE_RACE')
        raw = f.read(limit+1)
        require(len(raw)==before.st_size and stamp(os.fstat(f.fileno()))==stamp(before)==stamp(path.lstat()),
                'PAIR_FILE_CHANGED')
    return raw

def inventory(root, uid):
    protected(root,uid,True)
    files = {}
    entries = total = 0
    def walk(parent, depth=0):
        nonlocal entries,total
        require(depth <= 48, 'PAIR_DEPTH_LIMIT')
        before = protected(parent,uid,True)
        for p in sorted(parent.iterdir()):
            entries += 1
            require(entries<=MAX_FILES,'PAIR_ENTRY_LIMIT')
            rel=p.relative_to(root).as_posix()
            if rel=='release.json':
                continue
            s=p.lstat()
            if stat.S_ISDIR(s.st_mode):
                walk(p, depth+1)
            elif stat.S_ISLNK(s.st_mode):
                require(s.st_uid==uid and 'node_modules' in p.relative_to(root).parts,
                        'PAIR_LINK_DENIED:'+rel)
                link=os.readlink(p)
                require(not os.path.isabs(link) and p.resolve(strict=True).is_relative_to(root)
                        and p.resolve(strict=True).is_file()
                        and stamp(s)==stamp(p.lstat()),'PAIR_LINK_ESCAPE:'+rel)
                files[rel]='link:'+link
            else:
                total+=s.st_size
                require(total<=MAX_BYTES,'PAIR_INVENTORY_LIMIT')
                files[rel]=digest(read(p,uid,min(MAX_BYTES,128*1024**2)))
        require(stamp(parent.lstat())==stamp(before),'PAIR_DIRECTORY_CHANGED')
    walk(root)
    return files

def verify_tree(root, commit, manifest_pin, uid):
    require(hex_value(commit,SHA) and hex_value(manifest_pin,DIGEST),'PAIR_INVALID_PIN')
    require(root.name==commit,'PAIR_ROOT_IDENTITY')
    protected(root,uid,True)
    raw=read(root/'release.json',uid,32*1024**2)
    require(digest(raw)==manifest_pin,'PAIR_MANIFEST_PIN')
    m=json.loads(raw,object_pairs_hook=unique)
    require(isinstance(m,dict) and m.get('sourceCommit')==commit and isinstance(m.get('files'),dict),
            'PAIR_SOURCE_IDENTITY')
    require(m['files']==inventory(root,uid),'PAIR_INVENTORY_DRIFT')
    require(read(root/'release.json',uid,32*1024**2)==raw,'PAIR_MANIFEST_CHANGED')
    return m

def verify_pair(console,browsing,console_sha,browsing_sha,console_pin,browsing_pin,uid):
    c=verify_tree(console,console_sha,console_pin,uid)
    b=verify_tree(browsing,browsing_sha,browsing_pin,uid)
    cf,bf=c['files'],b['files']
    for files,names in ((cf,(LOCK,SESSION,'package-lock.json')),(bf,(WORKER,*LOCKFILES))):
        require(all(hex_value(files.get(n),DIGEST) for n in names),'PAIR_REQUIRED_MEMBER')
    require(c.get('lockfileSha256')==cf['package-lock.json'],'PAIR_CONSOLE_LOCKFILE')
    expected={'sourceCommit':console_sha,'manifestSha256':console_pin,
              'leaseModuleSha256':cf[LOCK],'sessionModuleSha256':cf[SESSION]}
    require(b.get('schemaVersion')==2 and b.get('console')==expected,'PAIR_CONSOLE_BINDING')
    require(b.get('lockfiles')=={n:bf[n] for n in LOCKFILES},'PAIR_BROWSING_LOCKFILES')
    return {'status':'BROWSING_PAIR_INVENTORY_PASS','consoleSHA':console_sha,
            'browsingSHA':browsing_sha,'consoleManifestSha256':console_pin,
            'browsingManifestSha256':browsing_pin,'leaseModuleSha256':cf[LOCK],
            'workerSha256':bf[WORKER],'activationEligible':False}

def admission(console_sha,browsing_sha,console_pin,browsing_pin):
    """Production entrypoint for a separately reviewed root-owned caller."""
    require(os.getuid()==os.geteuid()==0,'PAIR_ROOT_REQUIRED')
    require(hex_value(console_sha,SHA) and hex_value(browsing_sha,SHA),'PAIR_INVALID_SHA')
    selector = Path(__file__).with_name('release-store-selector.py')
    protected(selector,0)
    store = runpy.run_path(str(selector),run_name='pair_store_selector')['store'](BASE)
    console=store/console_sha
    browsing=BASE/'browsing-releases'/console_sha/browsing_sha
    for root in (console,browsing):
        for p in reversed(root.parents):
            protected(p,0,True)
        protected(root,0,True)
    return verify_pair(console,browsing,console_sha,browsing_sha,console_pin,browsing_pin,0)


def parse_policy(raw, console_sha):
    p=json.loads(raw,object_pairs_hook=unique)
    names={'schemaVersion','consoleSHA','browsingSHA','consoleManifestSha256','browsingManifestSha256'}
    require(type(p) is dict and set(p)==names and type(p['schemaVersion']) is int and p['schemaVersion']==1,'PAIR_POLICY_SCHEMA')
    require(p['consoleSHA']==console_sha and hex_value(p['consoleSHA'],SHA) and hex_value(p['browsingSHA'],SHA),'PAIR_POLICY_SHA')
    require(all(hex_value(p[n],DIGEST) for n in ('consoleManifestSha256','browsingManifestSha256')),'PAIR_POLICY_PIN')
    return p


def authorized_binding(console_sha):
    """Read only the separate root-authorized exact pair policy; no default grants."""
    require(os.getuid()==os.geteuid()==0,'PAIR_ROOT_REQUIRED')
    path=BASE/'browsing-pair-policy.json'
    for parent in reversed(path.parents):protected(parent,0,True)
    require(stat.S_IMODE(protected(path,0).st_mode)==0o600,'PAIR_POLICY_MODE')
    raw=read(path,0,65536)
    p=parse_policy(raw,console_sha)
    result=admission(p['consoleSHA'],p['browsingSHA'],p['consoleManifestSha256'],p['browsingManifestSha256'])
    require(read(path,0,65536)==raw,'PAIR_POLICY_CHANGED')
    return dict(result,policySha256=digest(raw))


def check_generation(binding, expected):
    require(type(binding) is dict and binding==expected,'PAIR_GENERATION_DRIFT')
    return binding
