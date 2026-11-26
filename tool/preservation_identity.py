import os,fcntl,stat,hashlib,json,socket,subprocess,sys,signal,secrets
from preservation_ipc import request,verified_bytes,client,MAX_REPORT

def metadata_stamp(st):
    return (st.st_dev,st.st_ino,st.st_mode,st.st_nlink,st.st_size,st.st_mtime_ns,st.st_ctime_ns)

def read_metadata(path,limit,*,with_mtime=False):
    path=os.fspath(path)
    parent=open_directory(os.path.dirname(os.path.abspath(path)))
    name=os.path.basename(path)
    try:
        fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
        with os.fdopen(fd,'rb') as stream:
            before=os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1 or before.st_size>limit:raise ValueError('BASELINE_CONFIG_POLICY')
            data=stream.read(limit+1)
            if len(data)!=before.st_size or len(data)>limit or metadata_stamp(os.fstat(stream.fileno()))!=metadata_stamp(before) or metadata_stamp(os.stat(name,dir_fd=parent,follow_symlinks=False))!=metadata_stamp(before):raise ValueError('IDENTITY_CHANGED')
            bound=open_directory(os.path.dirname(os.path.abspath(path)))
            try:
                if not os.path.samestat(os.fstat(bound),os.fstat(parent)):raise ValueError('IDENTITY_CHANGED')
            finally:os.close(bound)
            return (data,before.st_mtime_ns) if with_mtime else data
    finally:os.close(parent)
def open_directory(path):
    # Walk every component from a pinned root; never follow a directory alias.
    fd=os.open('/',os.O_PATH|os.O_DIRECTORY)
    try:
        for part in os.path.abspath(path).split('/')[1:]:
            if not part:continue
            child=os.open(part,os.O_PATH|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd);fd=child
        result=os.open('.',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
        os.close(fd);return result
    except BaseException:
        os.close(fd);raise

def snapshot_shared_metadata(identity,shadow):
    """Copy bounded Git objects and refs; no live links or external alternates."""
    import re,time
    deadline=time.monotonic()+20
    remaining=512*1024*1024
    entries=0
    root=open_directory(identity['common'])
    def check():
        if time.monotonic()>=deadline:raise TimeoutError('TIMEOUT')
    def copy_file(parent,name,target,limit):
        nonlocal remaining
        check()
        fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
        with os.fdopen(fd,'rb') as stream:
            before=os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1:raise ValueError('SHARED_METADATA_POLICY')
            if before.st_size>min(remaining,limit):raise ValueError('BASELINE_LIMIT')
            total=0
            with open(target,'xb') as dest:
                while True:
                    check()
                    chunk=stream.read(1024*1024)
                    if not chunk:break
                    total+=len(chunk);remaining-=len(chunk)
                    if total>limit or remaining<0:raise ValueError('BASELINE_LIMIT')
                    dest.write(chunk)
            if total!=before.st_size or metadata_stamp(os.fstat(stream.fileno()))!=metadata_stamp(before) or metadata_stamp(os.stat(name,dir_fd=parent,follow_symlinks=False))!=metadata_stamp(before):raise ValueError('IDENTITY_CHANGED')
    def walk(parent,name,target,kind,depth=0):
        nonlocal entries
        check()
        if depth>32:raise ValueError('BASELINE_LIMIT')
        fd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
        try:
            before=os.fstat(fd);os.mkdir(target,0o700)
            for entry in sorted(os.listdir(fd)):
                check();entries+=1
                if entries>100000:raise ValueError('BASELINE_LIMIT')
                st=os.stat(entry,dir_fd=fd,follow_symlinks=False)
                if stat.S_ISLNK(st.st_mode):raise ValueError('SHARED_METADATA_POLICY')
                if kind=='objects' and depth==0 and entry=='info':
                    info=os.open(entry,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
                    try:
                        if any(x in ('alternates','http-alternates') for x in os.listdir(info)):raise ValueError('SHARED_METADATA_POLICY')
                    finally:os.close(info)
                    # Commit graph and other acceleration metadata are deliberately omitted.
                    continue
                if kind=='objects' and depth==0:
                    if entry!='pack' and not re.fullmatch('[0-9a-f]{2}',entry):raise ValueError('SHARED_METADATA_POLICY')
                    if not stat.S_ISDIR(st.st_mode):raise ValueError('SHARED_METADATA_POLICY')
                if kind=='objects' and depth==1:
                    if name=='pack':
                        if not re.fullmatch(r'pack-[0-9a-f]{40}\.(pack|idx|rev|bitmap|keep|mtimes)',entry):raise ValueError('SHARED_METADATA_POLICY')
                    elif not re.fullmatch('[0-9a-f]{38}',entry):raise ValueError('SHARED_METADATA_POLICY')
                    if not stat.S_ISREG(st.st_mode):raise ValueError('SHARED_METADATA_POLICY')
                if kind=='refs' and depth==0 and entry=='replace':raise ValueError('SHARED_METADATA_POLICY')
                dest=os.path.join(target,entry)
                if stat.S_ISDIR(st.st_mode):walk(fd,entry,dest,kind,depth+1)
                elif stat.S_ISREG(st.st_mode):copy_file(fd,entry,dest,remaining if kind=='objects' else 1024*1024)
                else:raise ValueError('SHARED_METADATA_POLICY')
            if metadata_stamp(os.fstat(fd))!=metadata_stamp(before) or metadata_stamp(os.stat(name,dir_fd=parent,follow_symlinks=False))!=metadata_stamp(before):raise ValueError('IDENTITY_CHANGED')
        finally:os.close(fd)
    try:
        st=os.fstat(root)
        if (st.st_dev,st.st_ino)!=(identity['common_device'],identity['common_inode']):raise ValueError('IDENTITY_CHANGED')
        for name in ('objects','refs'):
            walk(root,name,os.path.join(shadow,name),name)
        for name in ('packed-refs','shallow'):
            try:os.stat(name,dir_fd=root,follow_symlinks=False)
            except FileNotFoundError:continue
            copy_file(root,name,os.path.join(shadow,name),16*1024*1024)
        packed=os.path.join(shadow,'packed-refs')
        if os.path.exists(packed):
            with open(packed,'rb') as stream:
                if any(b' refs/replace/' in line for line in stream):raise ValueError('SHARED_METADATA_POLICY')
        if metadata_stamp(os.fstat(root))!=metadata_stamp(st):raise ValueError('IDENTITY_CHANGED')
    finally:os.close(root)

def isolated_git_config(identity,shadow,env):
    # Parse only a bounded immutable byte snapshot, outside any repository.
    raw=read_metadata(os.path.join(identity['common'],'config'),1024*1024)
    if hashlib.sha256(raw).hexdigest()!=identity['config_sha256']:raise ValueError('IDENTITY_CHANGED')
    parsed=subprocess.run(['/usr/bin/git','config','--file','-','--no-includes','--null','--list'],input=raw,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,cwd=shadow,env=env,timeout=5)
    if parsed.returncode or len(parsed.stdout)>1024*1024:raise ValueError('BASELINE_CONFIG_POLICY')
    safe={'core.repositoryformatversion','core.filemode','core.bare','core.logallrefupdates','core.ignorecase','core.autocrlf','core.eol','core.symlinks','core.safecrlf','core.trustctime','core.checkstat','core.precomposeunicode','core.quotepath'}
    seen=set()
    for entry in parsed.stdout.split(b'\0'):
        if not entry:continue
        key,sep,value=entry.partition(b'\n')
        try:k=key.decode('ascii').lower();v=value.decode('ascii')
        except UnicodeDecodeError:
            if key.startswith((b'user.',b'remote.',b'branch.')):continue
            raise ValueError('BASELINE_CONFIG_POLICY')
        if k=='core.sharedrepository' or k.startswith(('user.','remote.','branch.','commit.','gpg.','push.','pull.','fetch.','receive.')):continue
        if k not in safe or k in seen:
            error=ValueError('BASELINE_CONFIG_POLICY');error.add_note('Unsupported or duplicate Git configuration key: '+k);raise error
        seen.add(k)
        if not sep:v='true'
        if k=='core.repositoryformatversion' and v!='0':raise ValueError('BASELINE_CONFIG_POLICY')
        if k=='core.bare' and v.lower() not in ('false','no','off','0'):raise ValueError('BASELINE_CONFIG_POLICY')
        if k=='core.quotepath':continue
        result=subprocess.run(['/usr/bin/git','config','--file',os.path.join(shadow,'config'),'--add',k,v],cwd=shadow,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5)
        if result.returncode:raise ValueError('BASELINE_CONFIG_POLICY')
    # Never link config, config.worktree or commondir into the isolated gitdir.
    snapshot_shared_metadata(identity,shadow)
    # Snapshot repository-local attributes and ignore rules; do not expose a
    # mutable info directory to Git. Other info metadata is not needed here.
    info=os.path.join(shadow,'info');os.mkdir(info,0o700)
    for name in ('attributes','exclude'):
        try:data=read_metadata(os.path.join(identity['common'],'info',name),1024*1024)
        except FileNotFoundError:continue
        with open(os.path.join(info,name),'xb') as stream:stream.write(data)
    # Git interprets a symlink HEAD as a symbolic ref, not as an arbitrary file alias.
    # Copy mutable per-worktree metadata into the private projection.
    for name,limit in (('HEAD',8192),('index',64*1024*1024)):
        target=os.path.join(identity['gitdir'],name)
        try:data,mtime=read_metadata(target,limit,with_mtime=True)
        except FileNotFoundError:
            if name=='HEAD':raise ValueError('GIT_ROOT')
            continue
        with open(os.path.join(shadow,name),'xb') as stream:
            stream.write(data);stream.flush()
            if name=='index':
                # A newer copy timestamp masks racy-clean entries: Git uses
                # index mtime as the cutoff for rehashing stat-cache matches.
                # Preserve the timestamp from the same verified input FD.
                os.utime(stream.fileno(),ns=(mtime,mtime))
                if os.fstat(stream.fileno()).st_mtime_ns!=mtime:
                    raise ValueError('BASELINE_INDEX_TIMESTAMP_POLICY')

class CollectorGit:
    """Linux broker-only adapter. Never run Git in the original gitdir."""
    def __init__(self,broker,identity):
        import tempfile
        self.broker=broker;self.identity=identity;self.cache={}
        # Keep crash-orphaned projections inside the broker's private store.
        self.tmp=tempfile.TemporaryDirectory(prefix='.projection-',dir=broker.store_path)
        self.env={'PATH':'/usr/bin:/bin','HOME':self.tmp.name,'GIT_OPTIONAL_LOCKS':'0','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':os.devnull,'GIT_TERMINAL_PROMPT':'0','GIT_NO_LAZY_FETCH':'1','GIT_ALLOW_PROTOCOL':'','GIT_ATTR_NOSYSTEM':'1','LC_ALL':'C'}
    def close(self):self.tmp.cleanup()
    def resolve(self,path):
        path=os.fspath(path)
        if os.path.realpath(path)!=path:raise ValueError('IDENTITY_CHANGED')
        # Reuse the same validated resolver for each discovered worktree.
        alias=self.identity['repository']
        previous=self.broker.repos
        try:
            self.broker.repos={alias:path}
            identity=self.broker.identity({'repository':alias})
        finally:self.broker.repos=previous
        if identity['common']!=self.identity['common'] or identity['config_sha256']!=self.identity['config_sha256']:raise ValueError('IDENTITY_CHANGED')
        if path==self.identity['path'] and identity!=self.identity:raise ValueError('IDENTITY_CHANGED')
        return identity
    def stamps(self,i):
        result=[]
        for path in (os.path.join(i['gitdir'],'HEAD'),os.path.join(i['gitdir'],'index'),os.path.join(i['common'],'info','attributes'),os.path.join(i['common'],'info','exclude')):
            try:result.append(metadata_stamp(os.stat(path,follow_symlinks=False)))
            except FileNotFoundError:result.append(None)
        return result
    def projection(self,path):
        import tempfile
        i=self.resolve(path); stamps=self.stamps(i)
        if path not in self.cache:
            shadow=tempfile.mkdtemp(dir=self.tmp.name)
            isolated_git_config(i,shadow,self.env)
            self.cache[path]=(i,stamps,shadow)
        old,old_stamps,shadow=self.cache[path]
        if i!=old or stamps!=old_stamps:raise ValueError('IDENTITY_CHANGED')
        return i,shadow
    def command(self,path,args,data=None):
        i,shadow=self.projection(path)
        argv=['/usr/bin/git','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','core.attributesFile=/dev/null','-c','core.excludesFile=/dev/null','-c','core.quotePath=true','--git-dir='+shadow,'--work-tree='+path,'-C',path,*args]
        import tempfile
        with tempfile.TemporaryFile() as out:
            result=subprocess.run(argv,input=data,stdout=out,stderr=subprocess.DEVNULL,env=self.env,timeout=25)
            if result.returncode:raise ValueError('BASELINE_GIT')
            out.seek(0);value=out.read(MAX_REPORT+1)
            if len(value)>MAX_REPORT:raise ValueError('BASELINE_LIMIT')
        self.projection(path)
        return value
    def worktrees(self):
        common=self.identity['common']
        if os.path.basename(common)!='.git':raise ValueError('GIT_COMMON')
        paths=[os.path.dirname(common)]
        directory=os.path.join(common,'worktrees')
        if os.path.lexists(directory):
            if not stat.S_ISDIR(os.lstat(directory).st_mode):raise ValueError('GIT_COMMON')
            names=sorted(os.listdir(directory))
            if len(names)>200:raise ValueError('BASELINE_LIMIT')
            for name in names:
                entry=os.path.join(directory,name)
                if not stat.S_ISDIR(os.lstat(entry).st_mode):raise ValueError('GIT_ROOT')
                raw=read_metadata(os.path.join(entry,'gitdir'),8192).rstrip(b'\r\n')
                marker=os.fsdecode(raw)
                if not os.path.isabs(marker) or os.path.basename(marker)!='.git':raise ValueError('GIT_ROOT')
                path=os.path.dirname(marker)
                if self.resolve(path)['gitdir']!=entry:raise ValueError('IDENTITY_CHANGED')
                paths.append(path)
        return paths
    def listing(self):
        result=[]
        for path in self.worktrees():
            i,_=self.projection(path)
            head=read_metadata(os.path.join(i['gitdir'],'HEAD'),8192).strip()
            oid=self.command(path,['rev-parse','HEAD']).strip()
            fields=[b'worktree '+os.fsencode(path),b'HEAD '+oid]
            if head.startswith(b'ref: refs/heads/'):fields.append(b'branch '+head[5:])
            elif head==oid:fields.append(b'detached')
            else:raise ValueError('GIT_ROOT')
            lock=os.path.join(i['gitdir'],'locked')
            if os.path.lexists(lock):
                reason=read_metadata(lock,8192).rstrip(b'\r\n')
                if b'\0' in reason:raise ValueError('GIT_ROOT')
                fields.append(b'locked'+(b' '+reason if reason else b''))
            result.append(b'\0'.join(fields)+b'\0\0')
        return b''.join(result)
    def reflog_oids(self):
        import re
        roots={os.path.join(self.identity['common'],'logs')}
        roots.update(os.path.join(self.resolve(p)['gitdir'],'logs') for p in self.worktrees())
        ids=set();total=0
        for root in roots:
            if not os.path.lexists(root):continue
            if not stat.S_ISDIR(os.lstat(root).st_mode):raise ValueError('GIT_ROOT')
            for base,dirs,files in os.walk(root,followlinks=False):
                if any(not stat.S_ISDIR(os.lstat(os.path.join(base,d)).st_mode) for d in dirs):raise ValueError('GIT_ROOT')
                for name in files:
                    raw=read_metadata(os.path.join(base,name),MAX_REPORT);total+=len(raw)
                    if total>MAX_REPORT:raise ValueError('BASELINE_LIMIT')
                    for line in raw.splitlines():
                        fields=line.split(b' ',2)
                        if len(fields)<3:raise ValueError('GIT_ROOT')
                        for oid in fields[:2]:
                            if not re.fullmatch(b'[0-9a-f]{40}',oid):raise ValueError('GIT_ROOT')
                            if oid!=b'0'*40:ids.add(oid)
        return ids
    def __call__(self,p,*args,data=None):
        path=os.fspath(p)
        if args==('rev-parse','--path-format=absolute','--git-common-dir'):
            return os.fsencode(self.resolve(path)['common'])+b'\n'
        if args==('worktree','list','--porcelain','-z'):return self.listing()
        if args[:3]==('rev-list','--all','--reflog'):
            ids=self.reflog_oids()
            ids.update(os.fsencode(x) for x in args[3:])
            return self.command(path,['rev-list','--all','--stdin'],b'\n'.join(sorted(ids))+b'\n')
        if args[0] in ('status','diff'):
            for entry in self.command(path,['ls-files','--stage','-z']).split(b'\0'):
                if entry.startswith(b'160000 '):raise ValueError('BASELINE_CONFIG_POLICY')
            for entry in self.command(path,['ls-tree','-r','-z','HEAD']).split(b'\0'):
                if entry.startswith(b'160000 '):raise ValueError('BASELINE_CONFIG_POLICY')
        return self.command(path,args,data)

class Hardened:
    def __init__(self,source,digest,owner,root,repos,store,allowed,timeout=30):
        self.source=source;self.digest=digest;self.owner=owner;self.root=root;self.repos=repos;self.allowed=allowed;self.timeout=timeout
        self.d=os.open(store,os.O_DIRECTORY|os.O_NOFOLLOW)
        st=os.fstat(self.d)
        if st.st_uid!=os.getuid() or st.st_mode&0o077: os.close(self.d);raise PermissionError('STORE')
        self.store_path=os.path.realpath(store)
        if not os.path.samestat(st,os.stat(self.store_path,follow_symlinks=False)):os.close(self.d);raise PermissionError('STORE')
    def close(self): os.close(self.d)
    def handle(self,s):
        return self.handle_request(request(s,self.allowed))
    def handle_request(self,r):
        if r['repository'] not in self.repos: raise ValueError('REPO')
        lock=os.open('.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600,dir_fd=self.d)
        try:
            st=os.fstat(lock)
            if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or st.st_nlink!=1 or st.st_mode&0o077: raise PermissionError('LOCK')
            try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError: return dict(status='BUSY',requestId=r['requestId'])
            import re,shutil
            if not os.path.samestat(os.fstat(self.d),os.stat(self.store_path,follow_symlinks=False)):raise PermissionError('STORE')
            for n in os.listdir(self.d):
                if re.fullmatch(r'\.pending-[0-9a-f]{32}',n):
                    st=os.stat(n,dir_fd=self.d,follow_symlinks=False)
                    if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or st.st_mode&0o077:raise PermissionError('STORE')
                    os.unlink(n,dir_fd=self.d)
                elif re.fullmatch(r'\.projection-[a-z0-9_]{8}',n):
                    st=os.stat(n,dir_fd=self.d,follow_symlinks=False)
                    if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or st.st_mode&0o077 or not shutil.rmtree.avoids_symlink_attacks:raise PermissionError('STORE')
                    shutil.rmtree(n,dir_fd=self.d)
            os.fsync(self.d)
            return self.run(r,lock)
        finally: os.close(lock)
    def identity(self,r):
        path=os.path.abspath(self.repos[r['repository']])
        if os.path.realpath(path)!=path:raise ValueError('IDENTITY')
        st=os.stat(path,follow_symlinks=False)
        if not stat.S_ISDIR(st.st_mode) or os.path.commonpath([os.path.realpath(self.root),path])!=os.path.realpath(self.root):raise ValueError('IDENTITY')
        # Resolve Git metadata without launching Git against untrusted local config.
        marker=os.path.join(path,'.git')
        ms=os.lstat(marker)
        if stat.S_ISDIR(ms.st_mode):
            gitdir=marker
        elif stat.S_ISREG(ms.st_mode):
            raw=read_metadata(marker,8192)
            if not raw.startswith(b'gitdir: ') or b'\n' in raw.rstrip(b'\r\n') or b'\0' in raw:raise ValueError('GIT_ROOT')
            gitdir=os.path.abspath(os.path.join(path,os.fsdecode(raw[8:].rstrip(b'\r\n'))))
            if os.path.realpath(gitdir)!=gitdir:raise ValueError('GIT_ROOT')
        else:raise ValueError('GIT_ROOT')
        if os.path.commonpath([os.path.realpath(self.root),gitdir])!=os.path.realpath(self.root):raise ValueError('GIT_ROOT')
        gs=os.stat(gitdir,follow_symlinks=False)
        if not stat.S_ISDIR(gs.st_mode):raise ValueError('GIT_ROOT')
        try: raw=read_metadata(os.path.join(gitdir,'commondir'),8192)
        except FileNotFoundError: common=gitdir
        else:
            if not raw.rstrip(b'\r\n') or b'\n' in raw.rstrip(b'\r\n') or b'\0' in raw:raise ValueError('GIT_COMMON')
            common=os.path.abspath(os.path.join(gitdir,os.fsdecode(raw.rstrip(b'\r\n'))))
            if os.path.realpath(common)!=common:raise ValueError('GIT_COMMON')
        cs=os.stat(common,follow_symlinks=False)
        if not stat.S_ISDIR(cs.st_mode) or os.path.commonpath([os.path.realpath(self.root),common])!=os.path.realpath(self.root):raise ValueError('GIT_COMMON')
        if gitdir!=common:
            if os.path.dirname(gitdir)!=os.path.join(common,'worktrees'):raise ValueError('GIT_COMMON')
            backref=read_metadata(os.path.join(gitdir,'gitdir'),8192).rstrip(b'\r\n')
            if backref!=os.fsencode(marker):raise ValueError('GIT_ROOT')
        elif not stat.S_ISDIR(ms.st_mode):raise ValueError('GIT_ROOT')
        config=read_metadata(os.path.join(common,'config'),1024*1024)
        return dict(repository=r['repository'],path=path,device=st.st_dev,inode=st.st_ino,gitdir=gitdir,gitdir_device=gs.st_dev,gitdir_inode=gs.st_ino,common=common,common_device=cs.st_dev,common_inode=cs.st_ino,config_sha256=hashlib.sha256(config).hexdigest(),collector=self.digest)
    def replay(self,target,r,identity):
        fd=os.open(target,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=self.d)
        with os.fdopen(fd,'rb') as f:
            st=os.fstat(f.fileno())
            if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or st.st_mode&0o077 or st.st_nlink!=1:raise PermissionError('REPORT')
            data=f.read(MAX_REPORT+8193)
        if len(data)>MAX_REPORT+8192:raise ValueError('REPORT_SIZE')
        lines=data.splitlines(keepends=True)
        if len(lines)<2:raise ValueError('REPORT')
        envelope=json.loads(lines[-1]);body=b''.join(lines[:-1]);receipt=json.loads(lines[-2])
        if envelope.get('type')!='broker_receipt' or envelope.get('identity')!=identity or envelope.get('requestId')!=r['requestId'] or envelope.get('body_sha256')!=hashlib.sha256(body).hexdigest() or receipt.get('preceding_jsonl_sha256')!=hashlib.sha256(b''.join(lines[:-2])).hexdigest() or envelope.get('status') not in ('COMPLETE','PARTIAL'):raise ValueError('REPLAY_MISMATCH')
        return dict(requestId=r['requestId'],status=envelope['status'],sha256=hashlib.sha256(data).hexdigest(),uid=os.getuid())
    def baseline(self,r,identity):
        import time,tempfile
        deadline=time.monotonic()+min(self.timeout,25)
        env={'PATH':'/usr/bin:/bin','HOME':os.path.expanduser('~'),'GIT_OPTIONAL_LOCKS':'0','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':os.devnull,'GIT_TERMINAL_PROMPT':'0','GIT_NO_LAZY_FETCH':'1','GIT_ALLOW_PROTOCOL':'','GIT_ATTR_NOSYSTEM':'1','LC_ALL':'C'}
        def git(args,limit):
            remaining=deadline-time.monotonic()
            if remaining<=0: raise TimeoutError('TIMEOUT')
            with subprocess.Popen(['/usr/bin/git','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','core.attributesFile=/dev/null','-c','core.excludesFile=/dev/null','-c','core.quotePath=true','--git-dir='+shadow,'--work-tree='+identity['path'],'-C',identity['path'],*args],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=env,start_new_session=True) as proc:
                import selectors
                sel=selectors.DefaultSelector()
                sel.register(proc.stdout,selectors.EVENT_READ)
                data=bytearray()
                try:
                    while True:
                        remaining=deadline-time.monotonic()
                        if remaining<=0 or not sel.select(remaining): raise TimeoutError('TIMEOUT')
                        chunk=os.read(proc.stdout.fileno(),65536)
                        if not chunk: break
                        data.extend(chunk)
                        if len(data)>limit: raise ValueError('BASELINE_LIMIT')
                    if proc.wait(timeout=max(.001,deadline-time.monotonic()))!=0: raise ValueError('BASELINE_GIT')
                    return bytes(data)
                finally:
                    sel.close()
                    if proc.poll() is None:
                        os.killpg(proc.pid,signal.SIGKILL);proc.wait()
        def capture():
            for entry in git(['ls-files','--stage','-z'],16*1024*1024).split(b'\0'):
                if entry.startswith(b'160000 '):raise ValueError('BASELINE_CONFIG_POLICY')
            for entry in git(['ls-tree','-r','-z','HEAD'],16*1024*1024).split(b'\0'):
                if entry.startswith(b'160000 '):raise ValueError('BASELINE_CONFIG_POLICY')
            head=git(['rev-parse','HEAD'],1024).decode('ascii').strip()
            if len(head)!=40 or any(c not in '0123456789abcdef' for c in head): raise ValueError('BASELINE_GIT')
            status=git(['status','--porcelain=v1','-z','--ignore-submodules=all'],16*1024*1024)
            staged=git(['diff','--cached','--no-ext-diff','--no-textconv','--ignore-submodules=all','--binary','HEAD','--','.'],16*1024*1024)
            unstaged=git(['diff','--no-ext-diff','--no-textconv','--ignore-submodules=all','--binary','--','.'],16*1024*1024)
            names=sorted(x for x in git(['ls-files','--others','--exclude-standard','-z'],4*1024*1024).split(b'\0') if x)
            if len(names)>200: raise ValueError('BASELINE_LIMIT')
            hashes=[]
            aggregate=0
            def stamp(s): return (s.st_dev,s.st_ino,s.st_mode,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
            for name in names:
                parts=name.split(b'/')
                if any(x in (b'',b'.',b'..') for x in parts): raise ValueError('BASELINE_ENCODING')
                if len(parts)>128: raise ValueError('BASELINE_LIMIT')
                fd=os.open(identity['path'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
                chain=[fd]
                try:
                    root=os.fstat(fd)
                    if (root.st_dev,root.st_ino)!=(identity['device'],identity['inode']): raise ValueError('IDENTITY_CHANGED')
                    directory_stamps=[stamp(root)]
                    for part in parts[:-1]:
                        child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
                        chain.append(child);fd=child
                        directory_stamps.append(stamp(os.fstat(fd)))
                    before=os.stat(parts[-1],dir_fd=fd,follow_symlinks=False)
                    if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1: raise ValueError('BASELINE_FILE_POLICY')
                    with os.fdopen(os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd),'rb') as stream:
                        opened=os.fstat(stream.fileno())
                        if stamp(opened)!=stamp(before): raise ValueError('IDENTITY_CHANGED')
                        h=hashlib.sha256()
                        total=0
                        while True:
                            if time.monotonic()>=deadline: raise TimeoutError('TIMEOUT')
                            chunk=stream.read(65536)
                            if not chunk: break
                            total+=len(chunk);aggregate+=len(chunk)
                            if total>16*1024*1024 or aggregate>128*1024*1024: raise ValueError('BASELINE_LIMIT')
                            h.update(chunk)
                        if total!=before.st_size or stamp(os.fstat(stream.fileno()))!=stamp(before) or stamp(os.stat(parts[-1],dir_fd=fd,follow_symlinks=False))!=stamp(before): raise ValueError('IDENTITY_CHANGED')
                        for i in range(len(chain)-1,-1,-1):
                            if stamp(os.fstat(chain[i]))!=directory_stamps[i]: raise ValueError('IDENTITY_CHANGED')
                            linked=os.stat(parts[i-1],dir_fd=chain[i-1],follow_symlinks=False) if i else os.stat(identity['path'],follow_symlinks=False)
                            if stamp(linked)!=directory_stamps[i]: raise ValueError('IDENTITY_CHANGED')
                    hashes.append(len(name).to_bytes(8,'big')+name+before.st_mode.to_bytes(4,'big')+h.digest())
                finally:
                    for descriptor in reversed(chain): os.close(descriptor)
            diff_ok=True
            try:
                for mode in ([],['--cached']):
                    if git(['diff',*mode,'--no-ext-diff','--no-textconv','--check'],4*1024*1024): diff_ok=False
            except ValueError as e:
                if str(e)!='BASELINE_GIT': raise
                diff_ok=False
            return dict(fingerprintVersion='preservation-v3',diffCheckOk=diff_ok,head=head,statusHash=hashlib.sha256(status).hexdigest(),worktreeFingerprint=hashlib.sha256(b'preservation-v3\0'+b''.join(len(part).to_bytes(8,'big')+part for part in (status,staged,unstaged,b'\n'.join(hashes)))).hexdigest(),untrackedCount=len(names))
        with tempfile.TemporaryDirectory(prefix='preservation-git-') as shadow:
            isolated_git_config(identity,shadow,env)
            first=capture()
        if self.identity(r)!=identity:raise ValueError('IDENTITY_CHANGED')
        with tempfile.TemporaryDirectory(prefix='preservation-git-') as shadow:
            isolated_git_config(identity,shadow,env)
            second=capture()
        if second!=first or self.identity(r)!=identity:raise ValueError('IDENTITY_CHANGED')
        return dict(requestId=r['requestId'],status='BASELINE_COMPLETE',uid=os.getuid(),workspace=identity['path'],baseline=first)
    def collect_isolated(self,b,identity,out,lock):
        import time,resource
        adapter=CollectorGit(self,identity)
        pid=None;reaped=False
        try:
            # The v3 server is single-threaded. Fork inherits the verified bundle
            # functions without reopening mutable module source. The lock remains
            # held in the child until exit, including if the parent dies.
            pid=os.fork()
            if pid==0:
                try:
                    os.setsid()
                    # Independent wall-clock limit, even if the broker parent dies.
                    signal.signal(signal.SIGALRM,lambda *_:os.killpg(os.getpgrp(),signal.SIGKILL))
                    signal.setitimer(signal.ITIMER_REAL,self.timeout)
                    os.dup2(out.fileno(),1)
                    with open(os.devnull,'wb') as sink:os.dup2(sink.fileno(),2)
                    for name in os.listdir('/proc/self/fd'):
                        descriptor=int(name)
                        if descriptor not in (0,1,2,lock):
                            try:os.close(descriptor)
                            except OSError:pass
                    sys.stdout=os.fdopen(1,'w',encoding='utf-8',closefd=False)
                    resource.setrlimit(resource.RLIMIT_FSIZE,(MAX_REPORT,MAX_REPORT))
                    namespace={'__name__':'verified_preservation_collector'}
                    exec(compile(b,'collector','exec'),namespace)
                    namespace['git']=adapter
                    namespace['ALLOWED']=[namespace['P'](self.root).resolve(strict=True)]
                    c=namespace['Collector']()
                    c.emit('host',host=namespace['platform'].node(),platform=namespace['platform'].platform(),user=namespace['getpass'].getuser(),uid=os.geteuid(),gid=os.getegid())
                    try:c.repo(namespace['P'](identity['path']))
                    except Exception as error:c.error(identity['path'],error)
                    result=c.finish()
                    sys.stdout.flush()
                    os._exit(int(result))
                except BaseException:os._exit(125)
            end=time.monotonic()+self.timeout
            while True:
                waited,status=os.waitpid(pid,os.WNOHANG)
                if waited==pid:
                    reaped=True
                    rc=os.waitstatus_to_exitcode(status)
                    if rc==-signal.SIGKILL:raise TimeoutError('TIMEOUT')
                    if rc not in (0,1):raise ValueError('COLLECTOR_EXIT')
                    return rc
                if time.monotonic()>=end:raise TimeoutError('TIMEOUT')
                time.sleep(.02)
        finally:
            if pid and not reaped:
                try:os.killpg(pid,signal.SIGKILL)
                except ProcessLookupError:
                    try:os.kill(pid,signal.SIGKILL)
                    except ProcessLookupError:pass
                os.waitpid(pid,0)
            if pid!=0:adapter.close()
    def run(self,r,lock):
        identity=self.identity(r)
        if r['operation']=='baseline':
            return self.baseline(r,identity)
        b=verified_bytes(self.source,self.digest,self.owner)
        target=r['requestId']+'.jsonl'
        try: os.stat(target,dir_fd=self.d,follow_symlinks=False)
        except FileNotFoundError: pass
        else: return self.replay(target,r,identity)
        tmp='.pending-'+secrets.token_hex(16)
        fd=os.open(tmp,os.O_CREAT|os.O_EXCL|os.O_RDWR|os.O_NOFOLLOW,0o600,dir_fd=self.d)
        try:
            with os.fdopen(fd,'w+b') as out:
                rc=self.collect_isolated(b,identity,out,lock)
                out.flush();os.fsync(out.fileno());out.seek(0);data=out.read(MAX_REPORT+1)
            lines=data.splitlines(keepends=True)
            if not lines or len(data)>MAX_REPORT: raise ValueError('REPORT')
            receipt=json.loads(lines[-1])
            if receipt.get('type')!='receipt' or receipt.get('preceding_jsonl_sha256')!=hashlib.sha256(b''.join(lines[:-1])).hexdigest(): raise ValueError('RECEIPT')
            if self.identity(r)!=identity:raise ValueError('IDENTITY_CHANGED')
            envelope=dict(type='broker_receipt',identity=identity,requestId=r['requestId'],body_sha256=hashlib.sha256(data).hexdigest(),status='COMPLETE' if rc==0 and receipt.get('status')=='observed_complete' else 'PARTIAL')
            extra=(json.dumps(envelope,sort_keys=True)+'\n').encode()
            if len(extra)>8192:raise ValueError('ENVELOPE_SIZE')
            with os.fdopen(os.open(tmp,os.O_WRONLY|os.O_APPEND|os.O_NOFOLLOW,dir_fd=self.d),'ab') as f:
                f.write(extra);f.flush();os.fsync(f.fileno())
            data+=extra
            os.link(tmp,target,src_dir_fd=self.d,dst_dir_fd=self.d,follow_symlinks=False);os.fsync(self.d)
            return dict(requestId=r['requestId'],status='COMPLETE' if rc==0 and receipt.get('status')=='observed_complete' else 'PARTIAL',sha256=hashlib.sha256(data).hexdigest(),uid=os.getuid())
        finally:
            try: os.unlink(tmp,dir_fd=self.d)
            except FileNotFoundError: pass
            os.fsync(self.d)
def serve_one(server,broker):
    s,_=server.accept()
    with s:
        r=None
        try:
            r=request(s,broker.allowed)
            reply=broker.handle_request(r)
            if r['operation']=='baseline' and reply.get('status')=='BASELINE_COMPLETE' and hasattr(broker,'attestation'):reply=dict(reply,attestation=broker.attestation)
        except (ValueError,OSError,TimeoutError,subprocess.SubprocessError) as e:
            allowed={'INCOMPLETE','LIMIT','FRAMING','DUPLICATE','ENVELOPE','TOKEN','PEER_DENIED','REPO','IDENTITY','GIT_ROOT','GIT_COMMON','SOURCE_POLICY','SOURCE_HASH','REPORT','REPORT_SIZE','REPLAY_MISMATCH','IDENTITY_CHANGED','ENVELOPE_SIZE','RECEIPT','LOCK','TIMEOUT','BASELINE_LIMIT','BASELINE_GIT','BASELINE_ENCODING','BASELINE_CONFIG_POLICY','BASELINE_FILE_POLICY','COLLECTOR_EXIT','STORE','SHARED_METADATA_POLICY'}
            code=e.args[0] if len(e.args)==1 and isinstance(e.args[0],str) and e.args[0] in allowed else 'REQUEST_TIMEOUT' if isinstance(e,TimeoutError) else 'INVALID_JSON' if isinstance(e,json.JSONDecodeError) else 'INTERNAL_REJECTION'
            reply=dict(status='REJECTED',reason=code)
            if r is not None: reply['requestId']=r['requestId']
        try: s.sendall(json.dumps(reply).encode()+b'\n')
        except OSError: pass  # A disconnected peer must not terminate the broker.
