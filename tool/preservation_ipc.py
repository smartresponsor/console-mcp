import os, socket, struct, json, re, hashlib, stat, subprocess, sys, tempfile, pathlib, time, threading
MAX_REQUEST=4096
MAX_REPORT=16*1024*1024
def peer(s):
    return struct.unpack('3i',s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]
def request(s, allowed):
    if peer(s) not in allowed: raise PermissionError('PEER_DENIED')
    end=time.monotonic()+3
    data=b''
    while b'\n' not in data:
        s.settimeout(max(.001,end-time.monotonic()))
        b=s.recv(min(1024,MAX_REQUEST+1-len(data)))
        if not b: raise ValueError('INCOMPLETE')
        data+=b
        if len(data)>MAX_REQUEST or time.monotonic()>end: raise ValueError('LIMIT')
    if not data.endswith(b'\n') or data.count(b'\n')!=1: raise ValueError('FRAMING')
    def unique(pairs):
        d={}
        for k,v in pairs:
            if k in d: raise ValueError('DUPLICATE')
            d[k]=v
        return d
    r=json.loads(data,object_pairs_hook=unique)
    if not isinstance(r,dict) or set(r)!={'version','operation','requestId','repository'} or type(r['version']) is not int or r['version']!=1 or r['operation'] not in ('preserve','baseline'): raise ValueError('ENVELOPE')
    for k in ('requestId','repository'):
        if not isinstance(r[k],str) or not re.fullmatch('[A-Za-z0-9-]{1,64}',r[k]): raise ValueError('TOKEN')
    return r
def verified_bytes(path,digest,owner):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as f:
        a=os.fstat(f.fileno())
        if not stat.S_ISREG(a.st_mode) or a.st_uid!=owner or a.st_mode&0o022 or a.st_nlink!=1 or a.st_size>1024*1024: raise PermissionError('SOURCE_POLICY')
        b=f.read(1024*1024+1)
        z=os.fstat(f.fileno())
        if (a.st_ino,a.st_size,a.st_mtime_ns,a.st_ctime_ns)!=(z.st_ino,z.st_size,z.st_mtime_ns,z.st_ctime_ns) or hashlib.sha256(b).hexdigest()!=digest: raise ValueError('SOURCE_HASH')
        return b
class Broker:
    def __init__(self,source,digest,owner,root,repos,store,allowed,timeout=30):
        self.source=source;self.digest=digest;self.owner=owner;self.root=root;self.repos=repos;self.store=pathlib.Path(store);self.allowed=allowed;self.timeout=timeout;self.lock=threading.Lock()
        st=self.store.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.geteuid() or st.st_mode&0o077: raise PermissionError('STORE_POLICY')
    def handle(self,s):
        r=request(s,self.allowed)
        if r['operation']!='preserve': raise ValueError('ENVELOPE')
        if r['repository'] not in self.repos: raise ValueError('REPO_DENIED')
        if not self.lock.acquire(False): return {'status':'BUSY','requestId':r['requestId']}
        try:
            return self.run(r)
        finally: self.lock.release()
    def run(self,r):
        b=verified_bytes(self.source,self.digest,self.owner)
        name=r['requestId']+'.jsonl'
        target=self.store/name
        if target.exists(): raise ValueError('REPLAY')
        fd,tmp=tempfile.mkstemp(dir=self.store,prefix='.pending-')
        try:
            with os.fdopen(fd,'wb') as out:
                # Execute exactly verified bytes, not a subsequently reopened path.
                import resource
                def limits():
                    resource.setrlimit(resource.RLIMIT_FSIZE,(MAX_REPORT,MAX_REPORT))
                proc=subprocess.Popen([sys.executable,'-I','-B','-c',b.decode(),'--allow-root',str(self.root),str(self.repos[r['repository']])],stdout=out,stderr=subprocess.DEVNULL,start_new_session=True,preexec_fn=limits)
                try: code=proc.wait(timeout=self.timeout)
                except subprocess.TimeoutExpired:
                    import signal
                    os.killpg(proc.pid,signal.SIGKILL);proc.wait();raise TimeoutError('COLLECTOR_TIMEOUT')
                out.flush();os.fsync(out.fileno())
            data=pathlib.Path(tmp).read_bytes()
            lines=data.splitlines(keepends=True)
            receipt=json.loads(lines[-1])
            if receipt.get('type')!='receipt' or receipt.get('preceding_jsonl_sha256')!=hashlib.sha256(b''.join(lines[:-1])).hexdigest(): raise ValueError('RECEIPT_INVALID')
            os.link(tmp,target)
            d=os.open(self.store,os.O_DIRECTORY);os.fsync(d);os.close(d)
            return {'requestId':r['requestId'],'status':'COMPLETE' if code==0 and receipt.get('status')=='observed_complete' else 'PARTIAL','sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'uid':os.geteuid()}
        finally:
            os.unlink(tmp)
def client(sock,server_uid,r):
    if peer(sock)!=server_uid: raise PermissionError('SERVER_DENIED')
    sock.settimeout(35);sock.sendall(json.dumps(r).encode()+b'\n')
    data=b''
    while not data.endswith(b'\n'):
        chunk=sock.recv(4096)
        if not chunk or len(data)+len(chunk)>65536: raise ValueError('RESPONSE_LIMIT')
        data+=chunk
    reply=json.loads(data)
    if reply.get('requestId')!=r['requestId']: raise ValueError('CORRELATION')
    return reply
def serve_one(broker,s):
    try: result=broker.handle(s)
    except (ValueError,PermissionError,TimeoutError,OSError) as e: result={'status':'REJECTED','reason':type(e).__name__}
    s.sendall(json.dumps(result).encode()+b'\n')
