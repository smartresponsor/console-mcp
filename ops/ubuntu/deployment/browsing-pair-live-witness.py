"""Read-only witnesses for the existing Ubuntu paired release controller.

No service lifecycle operations, no browser actions, no credentials in evidence.
The worker probes are deliberately non-mutating status or denied requests.
"""
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess

LEASE=Path('/run/console-mcp-browser-leases')
LIVE=Path('/home/alex/smartresponse/mcp/console-mcp')
LOCK='dist/service/visible-browser-process-lock.js'
WORKER='playwright-worker/src/worker.js'
CONSOLE_UNIT='console-mcp.service'
WORKER_UNIT='browser-mcp-worker.service'
MAX_BODY=65536

def require(ok,msg):
    if not ok:raise RuntimeError(msg)

def unique(pairs):
    result={}
    for k,v in pairs:
        require(k not in result,'PAIR_WITNESS_DUPLICATE_JSON')
        result[k]=v
    return result

def proc_identity(pid):
    require(type(pid) is int and pid>0,'PAIR_WITNESS_PID')
    p=Path('/proc')/str(pid)
    raw=(p/'stat').read_text()
    fields=raw[raw.rfind(')')+2:].split()
    status=dict(line.split(':',1) for line in (p/'status').read_text().splitlines() if ':' in line)
    uids=status['Uid'].split()
    require(uids==['993']*4 and p.stat().st_uid==993,'PAIR_WITNESS_UID')
    require(fields[0] not in ('Z','X','x'),'PAIR_WITNESS_PROCESS_DEAD')
    return (fields[19],os.readlink(p/'ns/mnt'),(p/'cgroup').read_text())

def unit_pid(show,unit):
    require(show(unit,'ActiveState')=='active','PAIR_WITNESS_UNIT_INACTIVE')
    raw=show(unit,'MainPID')
    require(raw.isdigit() and int(raw)>0,'PAIR_WITNESS_UNIT_PID')
    return int(raw)

def module_hash(root,path):
    p=root/str(path).lstrip('/')
    s=p.lstat()
    require(stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1 and not s.st_mode&0o022 and s.st_size<=128*1024**2,'PAIR_WITNESS_MODULE_TYPE')
    with os.fdopen(os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as f:
        def stamp(x):return (x.st_dev,x.st_ino,x.st_size,x.st_mtime_ns,x.st_ctime_ns,x.st_uid,x.st_mode,x.st_nlink)
        require(stamp(s)==stamp(os.fstat(f.fileno())),'PAIR_WITNESS_MODULE_RACE')
        data=f.read(s.st_size+1)
        require(len(data)==s.st_size and stamp(s)==stamp(os.fstat(f.fileno()))==stamp(p.lstat()),'PAIR_WITNESS_MODULE_DRIFT')
    return hashlib.sha256(data).hexdigest()

def proc_snapshot(pid,console,browsing,worker=False):
    before=proc_identity(pid)
    proc=Path('/proc')/str(pid)
    root=proc/'root'
    # The kernel namespace root link is intentional; no caller-supplied path.
    lease=root/str(LEASE).lstrip('/')
    s=lease.lstat()
    require(stat.S_ISDIR(s.st_mode) and s.st_uid==993 and stat.S_IMODE(s.st_mode)==0o700,'PAIR_WITNESS_LEASE')
    host=LEASE.lstat()
    require((s.st_dev,s.st_ino)==(host.st_dev,host.st_ino),'PAIR_WITNESS_HOST_LEASE_INODE')
    raw=(proc/'environ').read_bytes()
    require(len(raw)<=1024*1024,'PAIR_WITNESS_ENV_LIMIT')
    env={}
    for field in raw.split(b'\0'):
        if not field:continue
        k,v=field.decode().split('=',1)
        require(k not in env,'PAIR_WITNESS_ENV_DUPLICATE')
        env[k]=v
    argv=[v.decode() for v in (proc/'cmdline').read_bytes().split(b'\0') if v]
    lock_path=(console if worker else LIVE)/LOCK
    lock_hash=module_hash(root,lock_path)
    result=dict(pid=pid,uid=993,leaseIdentity=f'{s.st_dev}:{s.st_ino}',leaseMode=stat.S_IMODE(s.st_mode),leaseUid=s.st_uid,
                env=env,argv=argv,lockModuleSha256=lock_hash)
    if worker:result['workerSha256']=module_hash(root,browsing/WORKER)
    else:
        # The live bind-mounted entrypoint must be the sealed candidate inode.
        loaded=(root/str(LIVE/'dist/index.js').lstrip('/')).stat()
        sealed=(console/'dist/index.js').stat()
        require((loaded.st_dev,loaded.st_ino)==(sealed.st_dev,sealed.st_ino),'PAIR_WITNESS_CONSOLE_ENTRYPOINT')
    require(proc_identity(pid)==before,'PAIR_WITNESS_PID_DRIFT')
    again=lease.lstat()
    require((again.st_dev,again.st_ino,again.st_uid,again.st_mode)==(s.st_dev,s.st_ino,s.st_uid,s.st_mode),'PAIR_WITNESS_LEASE_DRIFT')
    return result

def listener_pid(port,run=subprocess.check_output):
    require(type(port) is int and 1<=port<=65535,'PAIR_WITNESS_PORT')
    raw=run(['/usr/bin/ss','-H','-ltnp','sport = :'+str(port)],text=True,timeout=5)
    rows=raw.strip().splitlines()
    require(len(rows)==1,'PAIR_WITNESS_LISTENER_COUNT')
    parts=rows[0].split(None,5)
    require(len(parts)==6 and parts[0]=='LISTEN' and parts[3]=='127.0.0.1:'+str(port),'PAIR_WITNESS_LISTENER_ADDRESS')
    pids=re.findall(r'pid=(\d+)',parts[5])
    require(len(pids)==1,'PAIR_WITNESS_LISTENER_OWNER')
    return int(pids[0])

def request(port,route,token='',drain_token=''):
    require(route in ('/worker-drain-status','/lease-v1/not-a-route'),'PAIR_WITNESS_ROUTE')
    headers={'Content-Type':'application/json','Connection':'close'}
    if token:headers['Authorization']='Bearer '+token
    if drain_token:headers['x-browser-worker-drain-token']=drain_token
    # Socket timeout alone is not an absolute deadline for a slow response.
    require(signal.getitimer(signal.ITIMER_REAL)==(0.0,0.0),'PAIR_WITNESS_TIMER_BUSY')
    previous=signal.getsignal(signal.SIGALRM)
    def expired(*args):raise TimeoutError('PAIR_WITNESS_HTTP_TIMEOUT')
    conn=http.client.HTTPConnection('127.0.0.1',port,timeout=3)
    signal.signal(signal.SIGALRM,expired)
    try:
        signal.setitimer(signal.ITIMER_REAL,5)
        conn.request('POST',route,body=b'{}',headers=headers)
        res=conn.getresponse()
        raw=res.read(MAX_BODY+1)
        require(len(raw)<=MAX_BODY,'PAIR_WITNESS_HTTP_LIMIT')
        value=json.loads(raw,object_pairs_hook=unique)
        require(type(value) is dict,'PAIR_WITNESS_HTTP_SCHEMA')
        return res.status,value
    finally:
        signal.setitimer(signal.ITIMER_REAL,0)
        signal.signal(signal.SIGALRM,previous)
        conn.close()

def worker_protocol(token,drain_token,port=8791,call=request,generation=None):
    require(isinstance(token,str) and isinstance(drain_token,str) and len(token)>=32 and len(drain_token)>=32 and token!=drain_token,'PAIR_WITNESS_AUTH_CONFIGURATION')
    status,body=call(port,'/worker-drain-status')
    require(status==401 and body.get('ok') is False,'PAIR_WITNESS_BEARER_REQUIRED')
    status,body=call(port,'/worker-drain-status',token)
    require(status==403 and body.get('status')=='WORKER_DRAIN_CONTROL_UNAVAILABLE','PAIR_WITNESS_DRAIN_TOKEN_REQUIRED')
    # Do not probe a potentially mutating route on a mismatched live worker.
    # Direct ingress denial belongs to the isolated Express acceptance suite.
    status,body=call(port,'/lease-v1/not-a-route',token)
    require(status==404 and body.get('status')=='WEB_SHARED_LEASE_ROUTE_DENIED' and body.get('mutation_attempted') is False,'PAIR_WITNESS_UNKNOWN_ROUTE')
    status,body=call(port,'/worker-drain-status',token,drain_token)
    count=body.get('activeOperations')
    draining=body.get('draining')
    require(status==200 and body.get('ok') is True and type(count) is int and count>=0 and type(draining) is bool and body.get('drained') is (draining and count==0) and body.get('status')==('WORKER_DRAINED' if draining and count==0 else 'WORKER_DRAINING' if draining else 'WORKER_ACTIVE') and body.get('mutation_attempted') is False and body.get('browser_mutated') is False,'PAIR_WITNESS_DRAIN_STATUS')
    result={'status':'PAIR_WORKER_PROTOCOL_PASS','draining':draining,'activeOperations':count,'drained':body['drained']}
    if generation is not None:
        require(type(generation) is str and re.fullmatch('[a-f0-9]{32}',generation) and type(body.get('ingressProtocol')) is int and body['ingressProtocol']==1 and body.get('ingressState')=='quiescing' and body.get('ingressGeneration')==generation and count==0 and body['drained'] is True,'PAIR_WITNESS_WORKER_STARTUP_BARRIER')
        result.update(ingressProtocol=1,ingressState='quiescing',ingressGeneration=generation)
    return result

def ingress_health(health,pid,generation=None):
    require(health.get('ok') is True and health.get('pid')==pid,'PAIR_WITNESS_CONSOLE_HEALTH')
    info=health.get('ingress')
    require(type(info) is dict and info.get('protocol')==1 and info.get('enabled') is True,'PAIR_BOOTSTRAP_LEGACY_INGRESS_UNSUPPORTED')
    count=info.get('activeHandlers')
    require(type(count) is int and count>=0,'PAIR_WITNESS_HANDLER_COUNT')
    if generation is not None:
        require(re.fullmatch('[a-f0-9]{32}',generation) and info.get('generation')==generation and info.get('state')=='quiescing' and count==0 and info.get('drained') is True,'PAIR_WITNESS_INGRESS_NOT_DRAINED')
    return {'protocol':1,'state':info.get('state'),'activeHandlers':count,'drained':info.get('drained') is True}

def witness(console,browsing,pair,runtime,show,rpc,generation):
    require(os.getuid()==os.geteuid()==0,'PAIR_WITNESS_ADMIN_REQUIRED')
    cp=unit_pid(show,CONSOLE_UNIT);wp=unit_pid(show,WORKER_UNIT)
    ci,wi=proc_identity(cp),proc_identity(wp)
    require(listener_pid(3334)==cp and listener_pid(8791)==wp,'PAIR_WITNESS_LISTENER_MISMATCH')
    c=proc_snapshot(cp,console,browsing);w=proc_snapshot(wp,console,browsing,True)
    result=runtime['verify_effective'](console,browsing,pair,c,w)
    ingress=ingress_health(rpc(cp,3334,'read_.system.console.health'),cp,generation)
    worker=worker_protocol(w['env']['BROWSER_MCP_BROWSER_WORKER_TOKEN'],w['env']['BROWSER_MCP_WORKER_DRAIN_TOKEN'],generation=generation)
    require(worker['drained'] is True and worker['activeOperations']==0,'PAIR_WITNESS_WORKER_NOT_DRAINED')
    require(unit_pid(show,CONSOLE_UNIT)==cp and unit_pid(show,WORKER_UNIT)==wp and proc_identity(cp)==ci and proc_identity(wp)==wi and listener_pid(3334)==cp and listener_pid(8791)==wp,'PAIR_WITNESS_RUNTIME_DRIFT')
    return dict(result,ingress=ingress,worker=worker,activationEligible=False)
