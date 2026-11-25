#!/usr/bin/env python3
"""Read-only Git preservation evidence. JSONL to stdout; no trust overrides."""
import argparse, base64, datetime, hashlib, json, os, pathlib, stat, subprocess, sys
from collections import Counter, deque
P=pathlib.Path
ap=argparse.ArgumentParser(description=__doc__)
ap.add_argument('--root',default='/home/alex/smartresponse')
ap.add_argument('--allow-external',action='store_true',help='Inspect registered worktrees outside root as well, using existing Git trust')
ap.add_argument('--timeout',type=int,default=180)
ap.add_argument('--expected-uid',type=int,default=1000)
a=ap.parse_args(); root=P(a.root).resolve(strict=True); counts=Counter(); seen=set(); common_seen=set(); pending=deque(); failed=False
# Preserve HOME and normal protected Git config; remove inherited repository/config overrides.
env={k:v for k,v in os.environ.items() if not k.startswith('GIT_')}; env.update(GIT_OPTIONAL_LOCKS='0',GIT_TERMINAL_PROMPT='0',GIT_NO_LAZY_FETCH='1',GIT_NO_REPLACE_OBJECTS='1',GIT_PROTOCOL_FROM_USER='0',GIT_ALLOW_PROTOCOL='',LC_ALL='C')
def emit(record_type,**kw):
    counts[record_type]+=1; print(json.dumps(dict(type=record_type,**kw),ensure_ascii=True),flush=True)
def err(where,error,**kw):
    global failed; failed=True; emit('error',where=str(where),error=str(error),**kw)
def git(w,*args,required=True):
    cmd=['git','--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','gc.auto=0','-c','maintenance.auto=false','-C',str(w),*args]
    try:
        r=subprocess.run(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=a.timeout)
        if r.returncode:
            if required: err(w,os.fsdecode(r.stderr),command=list(args),exit_code=r.returncode)
            return None
        return r.stdout
    except (OSError,subprocess.TimeoutExpired) as e:
        err(w,e,command=list(args)); return None

def meta(p):
    s=p.lstat(); return dict(uid=s.st_uid,gid=s.st_gid,mode=oct(stat.S_IMODE(s.st_mode)),device=s.st_dev,inode=s.st_ino,nlink=s.st_nlink,size=s.st_size,mtime_ns=s.st_mtime_ns,ctime_ns=s.st_ctime_ns,kind='symlink' if stat.S_ISLNK(s.st_mode) else 'directory' if stat.S_ISDIR(s.st_mode) else 'regular' if stat.S_ISREG(s.st_mode) else 'other')
def fingerprint(p):
    try:
        m=meta(p)
        if m['kind']=='symlink':
            b=os.fsencode(os.readlink(p)); return dict(**m,sha256=hashlib.sha256(b).hexdigest(),hash_kind='symlink-target-bytes',target=os.fsdecode(b))
        if m['kind']!='regular': return m
        fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        with os.fdopen(fd,'rb') as f:
            s=os.fstat(f.fileno()); h=hashlib.sha256()
            if (s.st_dev,s.st_ino)!=(m['device'],m['inode']) or not stat.S_ISREG(s.st_mode): raise RuntimeError('file identity changed')
            for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
            t=os.fstat(f.fileno())
        if (s.st_size,s.st_mtime_ns,s.st_ctime_ns)!=(t.st_size,t.st_mtime_ns,t.st_ctime_ns) or meta(p)!=m: raise RuntimeError('file changed while hashing')
        return dict(**m,sha256=h.hexdigest(),hash_kind='file-bytes')
    except FileNotFoundError: return {'kind':'absent'}
    except (OSError,RuntimeError) as e: err(p,e); return {'kind':'unavailable','error':str(e)}
def in_scope(p): return a.allow_external or p.is_relative_to(root)
def enqueue(p,source):
    try:
        p=P(p).resolve(strict=True)
        if not in_scope(p): err(p,'external registered path not inspected; use --allow-external',source=str(source)); return
        if p not in seen: pending.append(p)
    except OSError as e: err(p,e,source=str(source))
def raw_metadata(w):
    # No Git invocation needed to record ownership of the checkout and marker.
    try: emit('metadata',workspace=str(w),path=str(w),**meta(w))
    except OSError as e: err(w,e)
    marker=w/'.git'; m=fingerprint(marker); emit('metadata',workspace=str(w),path=str(marker),**m)
    if m.get('kind')=='regular':
        try:
            b=marker.read_bytes(); emit('git_marker',workspace=str(w),content_b64=base64.b64encode(b).decode())
        except OSError as e: err(marker,e)
def raw_logs(base,w):
    logs=base/'logs'
    if not logs.exists(): return
    for d,dirs,files in os.walk(logs,followlinks=False,onerror=lambda e:err(logs,e)):
        for n in files:
            p=P(d)/n; m=fingerprint(p); emit('reflog_file',workspace=str(w),path=str(p),**m)
            if m.get('kind')=='regular':
                try:
                    b=p.read_bytes()
                    if hashlib.sha256(b).hexdigest()!=m.get('sha256'): raise RuntimeError('reflog changed during read')
                    emit('reflog_content',workspace=str(w),path=str(p),content=os.fsdecode(b))
                except (OSError,RuntimeError) as e: err(p,e)
def stage_hash(w,oid):
    # Git blob bytes, not the working-tree copy. No external diff or filters.
    b=git(w,'cat-file','blob',oid)
    return None if b is None else hashlib.sha256(b).hexdigest()
def inspect(w):
    raw_metadata(w)
    top=git(w,'rev-parse','--is-bare-repository');
    if top is None: emit('workspace',path=str(w),status='GIT_INSPECTION_BLOCKED'); return
    bare=top.strip()==b'true'
    gd=git(w,'rev-parse','--absolute-git-dir'); cd=git(w,'rev-parse','--path-format=absolute','--git-common-dir')
    if gd is None or cd is None: return
    gd=P(os.fsdecode(gd.rstrip(b'\n'))).resolve(); cd=P(os.fsdecode(cd.rstrip(b'\n'))).resolve()
    if not in_scope(gd) or not in_scope(cd): err(w,'Git metadata outside permitted root',git_dir=str(gd),common_dir=str(cd)); return
    for p in {gd,cd,gd/'HEAD',gd/'commondir',gd/'gitdir',gd/'index',cd/'packed-refs'}: emit('metadata',workspace=str(w),path=str(p),**fingerprint(p))
    before_index=fingerprint(gd/'index')
    head=git(w,'rev-parse','--verify','HEAD',required=False); branch=git(w,'symbolic-ref','-q','HEAD',required=False)
    emit('workspace',path=str(w),status='INSPECTED',bare=bare,head=os.fsdecode(head.strip()) if head else None,branch=os.fsdecode(branch.strip()) if branch else None,git_dir=str(gd),common_dir=str(cd))
    if cd not in common_seen:
        common_seen.add(cd)
        refs=git(w,'for-each-ref','--format=%(refname)%09%(objectname)%09%(objecttype)%09%(symref)%09%(upstream)')
        if refs is not None:
            for l in refs.splitlines(): emit('ref',common_dir=str(cd),value=os.fsdecode(l))
        listing=git(w,'worktree','list','--porcelain','-z')
        if listing is not None:
            for field in listing.split(b'\0'):
                if field.startswith(b'worktree '): enqueue(os.fsdecode(field[9:]),w)
            emit('worktree_list',common_dir=str(cd),fields=[os.fsdecode(x) for x in listing.split(b'\0')])
        raw_logs(cd,w)
    if gd!=cd: raw_logs(gd,w)
    reflogs=git(w,'reflog','show','--all','--date=iso-strict','--format=%H%x09%gD%x09%gs')
    if reflogs is not None: emit('reflog_git',workspace=str(w),lines=[os.fsdecode(x) for x in reflogs.splitlines()])
    if bare: return
    # Refuse executable clean/process filters or external diff helpers rather than invoke them.
    cfg=git(w,'config','--null','--list')
    if cfg is None: return
    risky=[]
    for item in cfg.split(b'\0'):
        key,_,value=item.partition(b'\n'); k=key.lower()
        if value.strip() and ((k.startswith(b'filter.') and k.endswith((b'.clean',b'.process'))) or k==b'diff.external' or (k.startswith(b'diff.') and k.endswith((b'.command',b'.textconv')))): risky.append(os.fsdecode(key))
    if risky: err(w,'external filter/diff configured; status not executed',keys=risky); return
    status=git(w,'status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=dirty','--no-renames')
    index=git(w,'ls-files','--stage','-z')
    if status is None or index is None: return
    entries={}
    for x in index.split(b'\0'):
        if not x: continue
        hdr,sep,name=x.partition(b'\t')
        if not sep: err(w,'invalid index entry'); continue
        mode,oid,stage=hdr.decode('ascii').split(); entries.setdefault(name,[]).append((mode,oid,stage))
    dirty=[]
    for x in status.split(b'\0'):
        if not x: continue
        if len(x)<4 or x[2:3]!=b' ': err(w,'invalid status record'); continue
        xy=x[:2].decode('ascii'); name=x[3:]; p=w/os.fsdecode(name)
        # Reject escaping through a symlinked parent; leaf symlink itself is hashed as link text.
        if not p.parent.resolve().is_relative_to(w): err(p,'dirty path parent escapes checkout'); continue
        item={'workspace':str(w),'path':os.fsdecode(name),'xy':xy,'worktree':fingerprint(p),'index':[]}
        for mode,oid,stage in entries.get(name,[]):
            v=dict(mode=mode,oid=oid,stage=stage)
            if mode=='160000': v['kind']='gitlink'; v['sha256']=None
            else: v['sha256']=stage_hash(w,oid)
            item['index'].append(v)
        dirty.append(item); emit('dirty',**item)
    # Explicitly record gitlinks because recursive status was disabled; discovered submodule repos are inspected independently.
    for name,ents in entries.items():
        for mode,oid,stage in ents:
            if mode=='160000': emit('gitlink',workspace=str(w),path=os.fsdecode(name),oid=oid,stage=stage)
    after=git(w,'status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=dirty','--no-renames')
    if after!=status or fingerprint(gd/'index')!=before_index: err(w,'status/index changed during inspection')
    for item in dirty:
        if fingerprint(w/item['path'])!=item['worktree']: err(w,'dirty file changed during inspection',path=item['path'])
    emit('workspace_summary',workspace=str(w),dirty_count=len(dirty),status_sha256=hashlib.sha256(status).hexdigest(),index_before=before_index,index_after=fingerprint(gd/'index'),submodule_status='independent discovery; gitlink changes not inferred from recursive status')

if os.getuid()!=a.expected_uid or os.geteuid()!=a.expected_uid or os.geteuid()==0: sys.exit('Refusing execution: must run as expected nonroot owner')
emit('header',version='1.0',root=str(root),uid=os.getuid(),gid=os.getgid(),groups=os.getgroups(),time=datetime.datetime.now(datetime.timezone.utc).isoformat(),external=a.allow_external,git_version=subprocess.check_output(['git','--version'],env=env).decode().strip())
# Discover nested standalone/linked repos without following symlinks or traversing Git object stores.
for d,dirs,files in os.walk(root,followlinks=False,onerror=lambda e:err(root,e)):
    p=P(d)
    if '.git' in dirs or '.git' in files: enqueue(p,'filesystem')
    if '.git' in dirs: dirs.remove('.git')
    if 'HEAD' in files and 'objects' in dirs and 'refs' in dirs:
        enqueue(p,'bare candidate'); dirs[:]=[]
while pending:
    w=pending.popleft()
    if w in seen: continue
    seen.add(w); print(f'[{len(seen)}] {w}',file=sys.stderr,flush=True)
    try: inspect(w)
    except (OSError,ValueError,RuntimeError) as e: err(w,e)
emit('footer',complete=not failed,workspaces=len(seen),common_dirs=len(common_seen),counts=dict(counts),time=datetime.datetime.now(datetime.timezone.utc).isoformat())
sys.exit(2 if failed else 0)
