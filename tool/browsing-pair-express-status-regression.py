#!/usr/bin/python3
import http.client,json,os,runpy,secrets,socket,subprocess,tempfile,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
BROWSING=Path('/home/alex/smartresponse/mcp/looping/.worktrees/browsing-lease-reconcile-20261127')
M=runpy.run_path(str(ROOT/'ops/ubuntu/deployment/browsing-pair-live-witness.py'))
def require(ok,msg):
    if not ok:raise RuntimeError(msg)
with tempfile.TemporaryDirectory(prefix='browsing-express-status-') as tmp:
    with socket.socket() as s:
        s.bind(('127.0.0.1',0));port=s.getsockname()[1]
    require(port>=1024 and port not in (3333,3334,3335,8791,8793,8795,9223,9224,9230),'UNSAFE_FIXTURE_PORT')
    token=secrets.token_hex(32);drain=secrets.token_hex(32)
    env=dict(PATH='/usr/bin:/bin',HOME=tmp,PORT=str(port),BROWSER_MCP_WORKER_PORT=str(port),
             BROWSER_MCP_CONSOLE_ROOT=str(ROOT),BROWSER_MCP_REMOTE_DEBUGGING_PORT='9223',
             BROWSER_MCP_EXTERNAL_VISIBLE_BROWSER='true',BROWSER_MCP_HEADLESS='true',
             BROWSER_MCP_USER_DATA_DIR=tmp+'/profile',BROWSER_MCP_BROWSER_WORKER_TOKEN=token,
             BROWSER_MCP_WORKER_DRAIN_TOKEN=drain,CONSOLE_MCP_VISIBLE_OS_LEASES='required',
             CONSOLE_MCP_VISIBLE_LEASE_ROOT=tmp+'/lease')
    Path(tmp+'/lease').mkdir(mode=0o700)
    with open(tmp+'/worker.log','wb') as log:
        p=subprocess.Popen(['/usr/bin/node',str(BROWSING/'playwright-worker/src/worker.js')],cwd=tmp,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log)
        try:
            deadline=time.monotonic()+10
            while True:
                require(p.poll() is None,'EXPRESS_WORKER_EXIT')
                try:
                    # Verify the listener belongs to the exact fixture process.
                    require(M['listener_pid'](port)==p.pid,'EXPRESS_WORKER_PORT_COLLISION')
                    break
                except (OSError,RuntimeError,subprocess.SubprocessError):
                    require(time.monotonic()<deadline,'EXPRESS_WORKER_START_TIMEOUT')
                    time.sleep(.1)
            first=M['worker_protocol'](token,drain,port)
            require(first['draining'] is False and first['activeOperations']==0,'EXPRESS_INITIAL_STATE')
            def control(route):
                require(route in ('/worker-drain','/worker-resume'),'EXPRESS_CONTROL_ROUTE')
                require(p.poll() is None and M['listener_pid'](port)==p.pid,'EXPRESS_WORKER_IDENTITY')
                conn=http.client.HTTPConnection('127.0.0.1',port,timeout=3)
                try:
                    conn.request('POST',route,b'{}',{'Authorization':'Bearer '+token,'x-browser-worker-drain-token':drain,'Content-Type':'application/json'})
                    r=conn.getresponse();data=json.loads(r.read(65537))
                    require(r.status==200 and data.get('ok') is True and data.get('browser_mutated') is False,'EXPRESS_CONTROL_RESPONSE')
                    return data
                finally:conn.close()
            require(control('/worker-drain')['drained'] is True,'EXPRESS_DRAIN')
            second=M['worker_protocol'](token,drain,port)
            require(second['drained'] is True and second['activeOperations']==0,'EXPRESS_DRAIN_WITNESS')
            require(control('/worker-resume')['draining'] is False,'EXPRESS_RESUME')
            require(M['worker_protocol'](token,drain,port)['draining'] is False,'EXPRESS_RESUME_WITNESS')
            print('BROWSING_EXPRESS_STATUS_PROTOCOL_PASS (isolated process; no CDP operations)')
        finally:
            if p.poll() is None:
                p.terminate()
                try:p.wait(timeout=5)
                except subprocess.TimeoutExpired:p.kill();p.wait(timeout=5)
