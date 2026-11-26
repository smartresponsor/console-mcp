#!/usr/bin/env python3
"""Read-only Git evidence collector. Explicit trusted local repositories only; stdout JSONL.
No fetch, trust override, index refresh or source writes. Not a backup or atomic snapshot.
"""
import argparse, base64, hashlib, json, os, pathlib, platform, stat, subprocess, sys, getpass
P=pathlib.Path
ENV={k:v for k,v in os.environ.items() if not k.startswith('GIT_')}
ENV.update(GIT_OPTIONAL_LOCKS='0',GIT_TERMINAL_PROMPT='0',GIT_NO_LAZY_FETCH='1',GIT_CONFIG_NOSYSTEM='1',GIT_CONFIG_GLOBAL=os.devnull)
# Do not execute external diff/textconv or fsmonitor; local repository configuration must be trusted.
def git(p,*args,data=None):
    r=subprocess.run(['git','-c','core.fsmonitor=false','-c','core.hooksPath='+os.devnull,'-C',str(p),*args],input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=ENV,timeout=180)
    if r.returncode: raise RuntimeError(f'git {args[0]}: exit {r.returncode}: {r.stderr.decode(errors="replace")[:500]}')
    return r.stdout

def b64(b): return base64.b64encode(b).decode('ascii')
def sha(b): return hashlib.sha256(b).hexdigest()
def meta(s): return dict(dev=s.st_dev,ino=s.st_ino,uid=getattr(s,'st_uid',None),gid=getattr(s,'st_gid',None),mode=s.st_mode,size=s.st_size,mtime_ns=s.st_mtime_ns,ctime_ns=s.st_ctime_ns)
def comparable(s):
    m=meta(s)
    if os.name=='nt': m.pop('ctime_ns')
    return m
def filehash(p):
    a=p.lstat()
    if stat.S_ISLNK(a.st_mode): d=os.fsencode(os.readlink(p)); kind='symlink'
    elif stat.S_ISREG(a.st_mode):
        flags=os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_NONBLOCK',0)|getattr(os,'O_BINARY',0)
        fd=os.open(p,flags)
        with os.fdopen(fd,'rb') as f:
            if comparable(os.fstat(f.fileno()))!=comparable(a): raise RuntimeError('file changed before read')
            h=hashlib.sha256()
            for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
            if comparable(os.fstat(f.fileno()))!=comparable(a): raise RuntimeError('file changed during read')
        d=None; kind='file'
    else: raise RuntimeError('unsupported file type')
    if meta(p.lstat())!=meta(a): raise RuntimeError('file changed after read')
    return dict(kind=kind,sha256=sha(d) if d is not None else h.hexdigest(),metadata=meta(a))
class Collector:
    def __init__(self): self.errors=0; self.counts={}; self.digest=hashlib.sha256(); self.seen=set()
    def emit(self,record_type,**kw):
        line=(json.dumps(dict(type=record_type,**kw),ensure_ascii=True,sort_keys=True)+'\n').encode(); sys.stdout.buffer.write(line); self.digest.update(line); self.counts[record_type]=self.counts.get(record_type,0)+1
    def error(self,p,e): self.errors+=1; self.emit('error',path=str(p),message=str(e))
    def worktree(self,p):
        def snapshot(): return [git(p,'rev-parse','HEAD'),git(p,'status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=all'),git(p,'ls-files','--stage','-z'),git(p,'diff','--binary','--no-ext-diff','--no-textconv','--ignore-submodules=all'),git(p,'diff','--cached','--binary','--no-ext-diff','--no-textconv','--ignore-submodules=all')]
        a=snapshot(); self.emit('worktree_state',path=str(p),head=a[0].decode().strip(),status_b64=b64(a[1]),index_b64=b64(a[2]),unstaged_diff_sha256=sha(a[3]),staged_diff_sha256=sha(a[4]))
        entries=a[1].split(b'\0'); i=0
        while i<len(entries):
            e=entries[i]; i+=1
            if not e: continue
            code=e[:2].decode('ascii'); raw=e[3:]; old=None
            if 'R' in code or 'C' in code: old=entries[i]; i+=1
            name=os.fsdecode(raw); f=p/name
            try:
                if not f.parent.resolve().is_relative_to(p.resolve()): raise RuntimeError('parent escapes worktree')
                row=dict(status=code,path_b64=b64(raw),old_path_b64=b64(old) if old else None,worktree=str(p))
                try: row.update(filehash(f))
                except FileNotFoundError:
                    if 'D' not in code: raise
                    row.update(kind='deleted',sha256=None)
                self.emit('dirty_file',**row)
            except Exception as ex: self.error(f,ex)
        if snapshot()!=a: raise RuntimeError('Git state changed during collection')
    def repo(self,p):
        common=P(os.fsdecode(git(p,'rev-parse','--path-format=absolute','--git-common-dir').strip())).resolve()
        if common in self.seen: return
        self.seen.add(common)
        refs=git(p,'for-each-ref','--format=%(objectname) %(refname)'); listing=git(p,'worktree','list','--porcelain','-z')
        self.emit('repository',path=str(p),common_dir=str(common),refs_sha256=sha(refs),worktree_list_sha256=sha(listing))
        for r in refs.splitlines(): self.emit('ref',repository=str(common),record_b64=b64(r))
        roots=[]
        for block in listing.split(b'\0\0'):
            fields=block.split(b'\0'); root=next((x[9:] for x in fields if x.startswith(b'worktree ')),None)
            if root is None: continue
            w=P(os.fsdecode(root)); roots.append(w); self.emit('worktree',repository=str(common),record_b64=b64(block),path=str(w))
        # Raw reflog hashes + records, including per-worktree HEAD logs (files backend only).
        for base in [common/'logs',common/'worktrees']:
            if not base.exists(): continue
            for d,dirs,files in os.walk(base,followlinks=False):
                dirs[:]=[x for x in dirs if not (P(d)/x).is_symlink()]
                for n in files:
                    f=P(d)/n
                    if base.name=='worktrees' and 'logs' not in f.relative_to(base).parts: continue
                    try:
                        if not stat.S_ISREG(f.lstat().st_mode): raise RuntimeError('nonregular reflog')
                        m=filehash(f); data=f.read_bytes()
                        if sha(data)!=m['sha256']: raise RuntimeError('reflog changed')
                        # Avoid leaking identity/message text: preserve commit transitions only.
                        for i,line in enumerate(data.splitlines()): self.emit('reflog',path=str(f),line=i+1,transition=line.split(b' ',2)[:2][0].decode()+' '+line.split(b' ',2)[1].decode())
                        self.emit('reflog_file',path=str(f),**m)
                    except Exception as ex: self.error(f,ex)
        for w in roots:
            try:
                if w.is_symlink() or not w.is_dir(): raise RuntimeError('missing or aliased worktree')
                if not any(w.resolve().is_relative_to(a) for a in ALLOWED): raise RuntimeError('worktree outside explicit approved roots')
                if P(os.fsdecode(git(w,'rev-parse','--path-format=absolute','--git-common-dir').strip())).resolve()!=common: raise RuntimeError('repository identity mismatch')
                self.worktree(w)
            except Exception as ex: self.error(w,ex)
        # All reachable refs and reflog commits; include detached worktree heads explicitly.
        heads=[x[5:].decode() for x in listing.split(b'\0') if x.startswith(b'HEAD ')]
        commits=git(p,'rev-list','--all','--reflog',*heads).splitlines()
        for c in commits:
            try:
                oid=c.decode(); parents=git(p,'rev-list','--parents','-n','1',oid).split(); merge=len(parents)>2
                if merge: self.emit('patch_id',commit=oid,kind='merge_not_comparable',patch_id=None); continue
                diff=git(p,'show','--format=','--binary','--no-ext-diff','--no-textconv',oid); result=git(p,'patch-id','--stable',data=diff).split()
                self.emit('patch_id',commit=oid,kind='single_parent_or_root',patch_id=result[0].decode() if result else None)
            except Exception as ex: self.error(c,ex)
        if refs!=git(p,'for-each-ref','--format=%(objectname) %(refname)') or listing!=git(p,'worktree','list','--porcelain','-z'): raise RuntimeError('repository refs or worktrees changed')
    def finish(self):
        self.emit('receipt',status='partial' if self.errors else 'observed_complete',errors=self.errors,counts=self.counts.copy(),preceding_jsonl_sha256=self.digest.hexdigest(),limitations=['not atomic','not backup','ignored files excluded','submodule contents require separate explicit repository','reflog files backend only','ACL and Windows SID not captured','unreachable objects not enumerated','trusted local Git config required']); return bool(self.errors)
if __name__=='__main__':
    ap=argparse.ArgumentParser(); ap.add_argument('--allow-root',action='append',required=True); ap.add_argument('repositories',nargs='+'); args=ap.parse_args(); ALLOWED=[P(x).resolve(strict=True) for x in args.allow_root]; c=Collector(); c.emit('host',host=platform.node(),platform=platform.platform(),user=getpass.getuser(),uid=getattr(os,'geteuid',lambda:None)(),gid=getattr(os,'getegid',lambda:None)())
    for x in args.repositories:
        try:
            p=P(x).resolve(strict=True)
            if not any(p.is_relative_to(a) for a in ALLOWED): raise RuntimeError('repository outside approved roots')
            c.repo(p)
        except Exception as e: c.error(x,e)
    sys.exit(c.finish())
