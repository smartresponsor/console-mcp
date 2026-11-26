import os,fcntl,stat,hashlib,json,socket,subprocess,sys,signal,secrets
from preservation_ipc import request,verified_bytes,client,MAX_REPORT
class Hardened:
    def __init__(self,source,digest,owner,root,repos,store,allowed,timeout=30):
        self.source=source;self.digest=digest;self.owner=owner;self.root=root;self.repos=repos;self.allowed=allowed;self.timeout=timeout
        self.d=os.open(store,os.O_DIRECTORY|os.O_NOFOLLOW)
        st=os.fstat(self.d)
        if st.st_uid!=os.getuid() or st.st_mode&0o077: raise PermissionError('STORE')
    def close(self): os.close(self.d)
    def handle(self,s):
        r=request(s,self.allowed)
        if r['repository'] not in self.repos: raise ValueError('REPO')
        lock=os.open('.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600,dir_fd=self.d)
        try:
            st=os.fstat(lock)
            if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or st.st_nlink!=1 or st.st_mode&0o077: raise PermissionError('LOCK')
            try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError: return dict(status='BUSY',requestId=r['requestId'])
            for n in os.listdir(self.d):
                if n.startswith('.pending-'): os.unlink(n,dir_fd=self.d)
            os.fsync(self.d)
            return self.run(r)
        finally: os.close(lock)
    def run(self,r):
        b=verified_bytes(self.source,self.digest,self.owner)
        target=r['requestId']+'.jsonl'
        try: os.stat(target,dir_fd=self.d,follow_symlinks=False)
        except FileNotFoundError: pass
        else: raise ValueError('REPLAY')
        tmp='.pending-'+secrets.token_hex(16)
        fd=os.open(tmp,os.O_CREAT|os.O_EXCL|os.O_RDWR|os.O_NOFOLLOW,0o600,dir_fd=self.d)
        try:
            with os.fdopen(fd,'w+b') as out:
                code='import resource;resource.setrlimit(resource.RLIMIT_FSIZE,('+str(MAX_REPORT)+','+str(MAX_REPORT)+'));exec(compile('+repr(b.decode())+',"collector","exec"))'
                proc=subprocess.Popen([sys.executable,'-I','-B','-c',code,'--allow-root',str(self.root),str(self.repos[r['repository']])],stdout=out,stderr=subprocess.DEVNULL,start_new_session=True)
                try: rc=proc.wait(timeout=self.timeout)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid,signal.SIGKILL);proc.wait();raise TimeoutError('TIMEOUT')
                out.flush();os.fsync(out.fileno());out.seek(0);data=out.read(MAX_REPORT+1)
            lines=data.splitlines(keepends=True)
            if not lines or len(data)>MAX_REPORT: raise ValueError('REPORT')
            receipt=json.loads(lines[-1])
            if receipt.get('type')!='receipt' or receipt.get('preceding_jsonl_sha256')!=hashlib.sha256(b''.join(lines[:-1])).hexdigest(): raise ValueError('RECEIPT')
            os.link(tmp,target,src_dir_fd=self.d,dst_dir_fd=self.d,follow_symlinks=False);os.fsync(self.d)
            return dict(requestId=r['requestId'],status='COMPLETE' if rc==0 and receipt.get('status')=='observed_complete' else 'PARTIAL',sha256=hashlib.sha256(data).hexdigest(),uid=os.getuid())
        finally:
            os.unlink(tmp,dir_fd=self.d);os.fsync(self.d)
def serve_one(server,broker):
    s,_=server.accept()
    with s:
        try: reply=broker.handle(s)
        except (ValueError,OSError,TimeoutError) as e: reply=dict(status='REJECTED',reason=type(e).__name__)
        s.sendall(json.dumps(reply).encode()+b'\n')
