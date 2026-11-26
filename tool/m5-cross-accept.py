import hashlib,json,os,pathlib,socket,stat,struct,subprocess,tempfile,time

def sha(b):return hashlib.sha256(b).hexdigest()
def run(*args):return subprocess.check_output(args,text=True).strip()
def exchange(sock,request):
 with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
  s.settimeout(35);s.connect(str(sock))
  assert struct.unpack('3i',s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]==1000
  s.sendall(json.dumps(request).encode()+b'\n')
  with s.makefile('rb') as f:
   data=f.readline(65537)
  assert data.endswith(b'\n') and len(data)<=65536
  return json.loads(data)
def main():
 if os.getuid()!=1000:raise SystemExit('ALEX_UID_REQUIRED')
 base=pathlib.Path(__file__).resolve().parent
 manifest=json.loads((base/'m5-manifest.json').read_bytes())
 data={n:(base/n).read_bytes() for n in manifest}
 if any(sha(b)!=manifest[n] for n,b in data.items()):raise SystemExit('HASH_MISMATCH')
 home=pathlib.Path.home()/'.local/state';home.mkdir(parents=True,exist_ok=True)
 evidence=pathlib.Path(tempfile.mkdtemp(prefix='preservation-m5-',dir=home))
 print('EVIDENCE='+str(evidence),flush=True)
 with tempfile.TemporaryDirectory(prefix='.m5-',dir=str(base.parent)) as tmp:
  p=pathlib.Path(tmp);os.chown(p,-1,1001);p.chmod(0o710)
  private=p/'private';private.mkdir(mode=0o700);repo=private/'repo';repo.mkdir(mode=0o700)
  store=evidence/'reports';store.mkdir(mode=0o700)
  for n,b in data.items():
   f=private/n;f.write_bytes(b);f.chmod(0o400)
  def git(*args):return run('/usr/bin/git','-C',str(repo),*args)
  git('init','-q');git('config','user.email','fixture@example.invalid');git('config','user.name','Acceptance')
  (repo/'a').write_text('baseline\n');git('add','a');git('-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-qm','baseline')
  (repo/'a').write_text('modified\n');(repo/'untracked').write_text('new\n')
  before=(repo/'.git/index').read_bytes();head=git('rev-parse','HEAD')
  unit='preservation-m5-cross-'+str(os.getpid());sock=p/'s'
  code="""import sys,os,json,pathlib,hashlib
p=pathlib.Path(sys.argv[1]);store=pathlib.Path(sys.argv[2]);m=json.loads(sys.argv[3])
assert os.getuid()==1000
raw=(p/'preservation_bundle.py').read_bytes()
assert hashlib.sha256(raw).hexdigest()==m['preservation_bundle.py']
b={'__name__':'verified_bootstrap'};exec(compile(raw,'verified_bootstrap','exec'),b)
fd=os.open(p,os.O_DIRECTORY|os.O_NOFOLLOW)
try:server=b['load'](b['verify'](fd,{n:m[n+'.py'] for n in b['NAMES']},1000))
finally:os.close(fd)
s=sys.modules['preservation_activation'].inherited()
assert s.getsockname()==str(p.parent/'s')
broker=server.Hardened(p/'collector_windows.py',m['collector_windows.py'],1000,p,{'fixture':p/'repo'},store,{993})
trace=[]
original=broker.handle_request
def capture(r):
 result=original(r);trace.append(result);return result
broker.handle_request=capture
try:
 for _ in range(6):server.serve_one(s,broker)
 with (store/'trace.json').open('x') as f:json.dump(trace,f);f.flush();os.fsync(f.fileno())
 os.fsync(broker.d)
finally:broker.close();s.close()
"""
  try:
   print(run('systemd-run','--user','--unit='+unit,'--socket-property=ListenStream='+str(sock),'--socket-property=SocketMode=0660','--socket-property=SocketGroup=smartresponse','--property=NoNewPrivileges=yes','--property=KillMode=control-group','--property=UMask=0077','--property=RuntimeMaxSec=180','/usr/bin/python3','-I','-B','-c',code,str(private),str(store),json.dumps(manifest)),flush=True)
   for _ in range(100):
    if sock.exists():break
    time.sleep(.1)
   st=sock.stat();assert st.st_uid==1000 and st.st_gid==1001 and stat.S_IMODE(st.st_mode)==0o660
   denied=exchange(sock,dict(version=1,operation='baseline',requestId='owner-denied',repository='fixture'))
   assert denied==dict(status='REJECTED',reason='PEER_DENIED'),denied
   print('CROSS_UID_READY='+str(sock),flush=True)
   until=time.monotonic()+150
   while not (store/'trace.json').exists():
    if time.monotonic()>=until:raise TimeoutError('CLIENT_NOT_COMPLETED')
    time.sleep(.1)
   trace=json.loads((store/'trace.json').read_bytes());assert len(trace)==4,trace
   first,preserve,replay,last=trace
   assert first['status']==last['status']=='BASELINE_COMPLETE'
   assert first['uid']==last['uid']==1000 and first['workspace']==last['workspace']==str(repo)
   assert first['baseline']==last['baseline']
   assert first['baseline']['head']==head and first['baseline']['fingerprintVersion']=='preservation-v3'
   assert first['baseline']['untrackedCount']==1 and first['baseline']['diffCheckOk'] is True
   assert preserve==replay and preserve['status']=='COMPLETE'
   report=store/'cross-m5.jsonl';raw=report.read_bytes();lines=raw.splitlines(keepends=True)
   envelope=json.loads(lines[-1])
   assert envelope['body_sha256']==sha(b''.join(lines[:-1])) and preserve['sha256']==sha(raw)
   assert before==(repo/'.git/index').read_bytes() and head==git('rev-parse','HEAD')
   result=dict(status='M5_CROSS_UID_ACCEPTANCE_PASS',manifest=manifest,baseline=first['baseline'],report_sha256=sha(raw),report=str(report),owner_uid=1000,authorized_uid=993,owner_denied=True)
   with (evidence/'receipt.json').open('x') as f:json.dump(result,f);f.flush();os.fsync(f.fileno())
   fd=os.open(evidence,os.O_DIRECTORY);os.fsync(fd);os.close(fd)
   print(json.dumps(result),flush=True)
  finally:
   for suffix in ('.socket','.service'):
    name=unit+suffix
    state=subprocess.run(['systemctl','--user','show',name,'-p','LoadState','--value'],capture_output=True,text=True)
    if state.stdout.strip()=='not-found':continue
    stopped=subprocess.run(['systemctl','--user','stop',name],capture_output=True,text=True)
    if stopped.returncode:
     state=subprocess.run(['systemctl','--user','show',name,'-p','LoadState','--value'],capture_output=True,text=True)
     if state.stdout.strip()!='not-found':raise RuntimeError('CLEANUP_FAILED: '+name)
    active=subprocess.run(['systemctl','--user','is-active',name],capture_output=True,text=True)
    if active.stdout.strip() not in ('inactive','unknown','failed'):raise RuntimeError('CLEANUP_NOT_VERIFIED: '+name)
if __name__=='__main__':main()
