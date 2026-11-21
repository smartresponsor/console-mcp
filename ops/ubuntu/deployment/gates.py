#!/usr/bin/python3
import hashlib,json,os,pathlib,re,socket,subprocess,sys,time,urllib.request,runpy
STORE_SELECTOR = runpy.run_path(str(pathlib.Path(__file__).with_name('release-store-selector.py')))['store']
B=pathlib.Path('/opt/console-mcp-deploy');L=pathlib.Path('/home/alex/smartresponse/mcp/console-mcp')
def show(unit,prop):return subprocess.check_output(['/usr/bin/systemctl','show',unit,'--value','-p',prop],text=True).strip()
def env(pid):return dict(x.split('=',1) for x in pathlib.Path(f'/proc/{pid}/environ').read_bytes().decode().split('\0') if '=' in x)

class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,req,fp,code,msg,headers,newurl):return None
def rpc(pid,port,name,args=None):
 e=env(pid); headers={'Authorization':'Bearer '+e['CONSOLE_MCP_BEARER_TOKEN'],'Content-Type':'application/json','Accept':'application/json, text/event-stream'}
 def request(body):
  req=urllib.request.Request(f'http://127.0.0.1:{port}/mcp',data=json.dumps(body).encode(),headers=headers)
  opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
  with opener.open(req,timeout=10) as r:
   if r.headers.get('Mcp-Session-Id'):headers['Mcp-Session-Id']=r.headers['Mcp-Session-Id']
   if 'text/event-stream' in r.headers.get('Content-Type',''):
    deadline=time.monotonic()+15;size=0;data=''
    while time.monotonic()<deadline:
     line=r.readline(1048577-size);size+=len(line)
     if size>1048576:raise RuntimeError('MCP response size limit')
     if not line:break
     if line.startswith(b'data: '):data=line[6:].decode();break
    if not data:raise RuntimeError('MCP response deadline')
   else:
    raw=r.read(1048577)
    if len(raw)>1048576:raise RuntimeError('MCP response size limit')
    data=raw.decode()
  if not data:return {}
  return json.loads(next((line[6:] for line in data.splitlines() if line.startswith('data: ')),data))
 hello=request({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'deployment-gate','version':'1'}}})
 if isinstance(hello.get('result',{}).get('protocolVersion'),str):headers['MCP-Protocol-Version']=hello['result']['protocolVersion']
 request({'jsonrpc':'2.0','method':'notifications/initialized'})
 out=request({'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':name,'arguments':args or {}}})
 if 'error' in out:raise RuntimeError('MCP RPC error')
 text=out['result']['content'][0]['text']
 try:return json.loads(text)
 except ValueError:return {'ok':False,'nonJsonToolError':text[:1200]}
def agent(op,**kw):
 request_id='deployment-gates'
 request=dict(version=1,requestId=request_id,operation=op,**kw)
 try:
  p=subprocess.run(['/usr/sbin/runuser','-u','alex','--','/usr/bin/setpriv','--no-new-privs','/usr/bin/python3','-I',str(L/'ops/ubuntu/script/desktop-agent-client.py')],input=json.dumps(request),text=True,capture_output=True,timeout=20,check=False)
 except subprocess.TimeoutExpired:
  return {'ok':False,'status':'DESKTOP_AGENT_CLIENT_TIMEOUT','reason':'CLIENT_TIMEOUT','requestId':request_id}
 except OSError:
  return {'ok':False,'status':'DESKTOP_AGENT_CLIENT_UNAVAILABLE','reason':'CLIENT_EXEC_FAILED','requestId':request_id}
 if p.returncode != 0:
  return {'ok':False,'status':'DESKTOP_AGENT_CLIENT_FAILED','reason':'CLIENT_EXIT_NONZERO','requestId':request_id,'exitCode':p.returncode}
 try:
  result=json.loads(p.stdout)
 except (TypeError,ValueError):
  return {'ok':False,'status':'DESKTOP_AGENT_INVALID_RESPONSE','reason':'RESPONSE_NOT_JSON','requestId':request_id}
 if not isinstance(result,dict) or result.get('requestId') != request_id:
  return {'ok':False,'status':'DESKTOP_AGENT_INVALID_RESPONSE','reason':'RESPONSE_ID_MISMATCH','requestId':request_id}
 return result
def browser_processes():
 rows={}
 for port in (9223,9224):
  out=subprocess.check_output(['/usr/bin/ss','-ltnpH','sport = :'+str(port)],text=True)
  pids=sorted(set(re.findall(r'pid=(\d+)',out)));assert len(pids)==1,'CDP listener owner ambiguous'
  p=pathlib.Path('/proc')/pids[0];stat=p.joinpath('stat').read_text();fields=stat[stat.rfind(')')+2:].split()
  rows[str(port)]={'pid':int(pids[0]),'startTicks':fields[19],'uid':p.stat().st_uid}
 return rows
def session_targets(targets):
 # Page IDs are attachment identities. Child iframe/JS-worker IDs naturally churn
 # without closing or replacing any page, browser or authenticated worker service.
 pages=sorted((x['id'],x['type']) for x in targets if x['type']=='page')
 if len({x[0] for x in pages})!=len(pages):raise RuntimeError('ambiguous page target identity')
 return pages

def browser():
 result={'cdp':{},'windows':[],'services':{}}
 for port in (9223,9224):
  data=json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json/list',timeout=5));ver=json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json/version',timeout=5))
  result['cdp'][str(port)]={'targets':session_targets(data),'instance':ver['webSocketDebuggerUrl']}
 w=agent('window-inventory');assert w['ok']
 result['windows']=sorted((x['windowId'],x['pid']) for x in w['windows'] if 'edge' in x.get('wmClass','').lower())
 for unit in ('console-mcp-browser.service','console-mcp-visible-worker.service','console-mcp-grants-browser.service','console-mcp-grants-web-worker.service'):
  assert show(unit,'ActiveState')=='active';assert not show(unit,'BindsTo');assert not show(unit,'PartOf')
  result['services'][unit]=show(unit,'MainPID')
 return json.loads(json.dumps(result))
def _queue_read_record(p):
 # Read exactly one inode; no unchecked text read after pathname validation.
 import stat
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK)
 try:
  st=os.fstat(fd)
  named=os.lstat(p)
  if (not stat.S_ISREG(st.st_mode) or st.st_nlink!=1 or st.st_size>1048576
      or (st.st_dev,st.st_ino)!=(named.st_dev,named.st_ino)):
   raise RuntimeError('QUEUE_RECORD_UNTRUSTED: '+str(p))
  with os.fdopen(fd,'rb',closefd=False) as stream:raw=stream.read(1048577)
  if len(raw)>1048576:raise RuntimeError('QUEUE_RECORD_TOO_LARGE: '+str(p))
  data=json.loads(raw)
  if not isinstance(data,dict) or not isinstance(data.get('status'),str):
   raise RuntimeError('QUEUE_RECORD_INVALID: '+str(p))
  return data
 finally:os.close(fd)


def queue_snapshot(engine_root,source_root,proc_root=pathlib.Path('/proc')):
 # A previously missing/unreadable root, failed traversal or changing record
 # is UNKNOWN, not proof of an empty queue. This function is read-only.
 if not engine_root.is_dir() or not source_root.is_dir():
  raise RuntimeError('QUEUE_ROOT_MISSING')
 paths=list(engine_root.glob('*.json'))
 managed_paths=[]
 def walk_error(error):raise RuntimeError('QUEUE_TRAVERSAL_FAILED') from error
 for root,dirs,files in os.walk(source_root,onerror=walk_error,followlinks=False):
  if '.console-mcp' in dirs:
   base=pathlib.Path(root)/'.console-mcp'
   paths.extend((base/'command-run').glob('*/state.json'))
   paths.extend((base/'powershell-script-run').glob('*/state.json'))
   managed_paths.extend(base.glob('local-php-server-*.json'))
   managed_paths.extend(base.glob('mobile-edge-server.json'))
  if 'var' in dirs:
   gallery=pathlib.Path(root)/'var/.visual-gallery/server.json'
   if gallery.is_symlink() or gallery.exists():managed_paths.append(gallery)
  dirs[:]=[d for d in dirs if d not in ('.git','node_modules','tmp','var','browser','profiles','.cache','.config','.console-mcp')]
 active=[];stale=[];checked=0
 # Deduplicate canonical source records but never silently skip any discovered
 # invalid or unreadable state entry.
 for path in sorted(set(paths),key=str):
  try:data=_queue_read_record(path)
  except (OSError,ValueError,RuntimeError) as error:
   raise RuntimeError('QUEUE_RECORD_UNREADABLE_OR_INVALID: '+str(path)) from error
  checked+=1
  status=data['status']
  pid=data.get('pid')
  # A terminal state cannot be assumed for an unknown/future status.
  terminal={'succeeded','failed','stopped','timed_out','completed','cancelled','canceled','done'}
  if status not in terminal:
   if isinstance(pid,bool) or pid is not None and (not isinstance(pid,int) or pid<=0):
    raise RuntimeError('QUEUE_PID_INVALID: '+str(path))
   if pid is not None and not (proc_root/str(pid)).exists():
    stale.append(str(path))
   else:active.append(str(path))
 # A detached managed service survives its start() admission. Every
 # discovered state record is treated as unsafe during release validation,
 # even if its PID vanished: lifecycle/identity reconciliation is separate.
 managed=[]
 for path in sorted(set(managed_paths),key=str):
  try:
   fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK)
   try:
    st=os.fstat(fd);named=os.lstat(path)
    import stat
    if (not stat.S_ISREG(st.st_mode) or st.st_nlink!=1 or st.st_size>1048576
        or (st.st_dev,st.st_ino)!=(named.st_dev,named.st_ino)):
     raise RuntimeError('MANAGED_SERVER_RECORD_UNTRUSTED')
    with os.fdopen(fd,'rb',closefd=False) as stream:raw=stream.read(1048577)
    data=json.loads(raw)
    if len(raw)>1048576 or not isinstance(data,dict) or type(data.get('pid')) is not int or data['pid']<=0:
     raise RuntimeError('MANAGED_SERVER_RECORD_INVALID')
   finally:os.close(fd)
  except (OSError,ValueError,RuntimeError) as error:
   raise RuntimeError('MANAGED_SERVER_RECORD_UNREADABLE: '+str(path)) from error
  managed.append(str(path))
 return {'checked':checked,'active':active,'staleDeadProcessRecords':stale,
         'managedServerRecords':managed,'at':time.time()}


def queue():
 # The exclusive admission lock MUST be held across this entire gate and
 # isolated sandbox validation. A retained orphan fence denies release.
 admission_path=B/'admission-lock.py'
 if not admission_path.is_file() or admission_path.is_symlink():
  raise RuntimeError('ADMISSION_CONTROLLER_UNTRUSTED')
 admission=runpy.run_path(str(admission_path),run_name='deployment_admission_library')
 admission['assert_inflight_empty']()
 report=queue_snapshot(pathlib.Path('/var/lib/console-mcp/run/engine/task'),
                       pathlib.Path('/home/alex/smartresponse'))
 (B/'queue-last.json').write_text(json.dumps(report,indent=2))
 if report['active'] or report['staleDeadProcessRecords'] or report['managedServerRecords']:
  raise RuntimeError('deployment process inventory not empty: active='+str(len(report['active']))+
                     ', stale='+str(len(report['staleDeadProcessRecords']))+
                     ', managed='+str(len(report['managedServerRecords'])))

def verify_browser_snapshot(reg):
 identities=browser_processes();assert identities==json.loads((B/'browser-processes.json').read_text()),'CDP process identity drift'
 actual=browser();assert actual==json.loads((B/'browser-baseline.json').read_text()),'browser/worker identity drift'
 assert len(actual['windows'])==reg['expectedWindowCount'],'native window baseline count changed'
 assert sum(sum(t[1]=='page' for t in c['targets']) for c in actual['cdp'].values())==reg['expectedPageCount'],'page baseline count changed'
 return actual
def main():
 mode=sys.argv[1];pid=int(show('console-mcp.service','MainPID'));reg=json.loads((B/'registry.json').read_text())
 if mode=='rollback':
  # After a reboot the GUI/browser PIDs may legitimately differ or be unavailable.
  # Never turn that observation into an endless loop of runtime restarts.
  expected=json.loads((STORE_SELECTOR(B)/reg['rollback']/'release.json').read_text())['buildFingerprint']
  h=None
  for i in range(20):
   try:h=rpc(pid,3334,'read_.system.console.health');break
   except Exception:time.sleep(1)
  assert h and h.get('ok') and h.get('pid')==pid and h.get('buildFingerprint')==expected
  preserved=False
  try:preserved=browser()==json.loads((B/'browser-baseline.json').read_text()) and browser_processes()==json.loads((B/'browser-processes.json').read_text())
  except Exception:pass
  result={'pid':pid,'buildFingerprint':expected,'health_verified':True,'browser_preservation_verified':preserved,'at':time.time()}
  (B/'rollback-health.json').write_text(json.dumps(result,indent=2));print(json.dumps(result));print('GATES_PASS_ROLLBACK');return
 if mode=='baseline':
  (B/'browser-baseline.json').write_text(json.dumps(browser(),indent=2));print('BROWSER_BASELINE_SAVED');return
 if mode!='rollback':queue()
 actual=verify_browser_snapshot(reg)
 assert not show('console-mcp.service','BindsTo');assert not show('console-mcp.service','PartOf')
 if mode=='pre':
  for name in ('console-mcp.service','dropins'):
   saved=B/'checkpoints'/reg['checkpoint']/name
   current=pathlib.Path('/etc/systemd/system')/('console-mcp.service' if name=='console-mcp.service' else 'console-mcp.service.d')
   if saved.is_file():assert saved.read_bytes()==current.read_bytes(),'unit drift'
   else:
    for f in saved.glob('*.conf'):assert f.read_bytes()==(current/f.name).read_bytes(),'override drift'
  assert (B/'checkpoints'/reg['checkpoint']/'environment').read_bytes()==pathlib.Path('/etc/console-mcp/console-mcp.env').read_bytes(),'environment drift'
  rollback_proof=json.loads((B/'rollback-sandbox-result.json').read_text())
  assert rollback_proof['passed'] and rollback_proof['rollback']==reg['rollback'],'rollback sandbox identity mismatch'
  assert pid==reg['oldPid'],'incumbent PID changed'
  h=rpc(pid,3334,'read_.system.console.health');assert h['ok'] and h['pid']==pid
  assert (B/'sandbox-result.json').exists();s=json.loads((B/'sandbox-result.json').read_text());assert s['candidate']==reg['candidate'] and s['sourceSHA']==reg['sourceSHA'] and s['passed'] and time.time()-s['at']<600,'sandbox proof stale'
  # Refresh the actual service sandbox: native visibility and independent inert lease test.
  subprocess.run(['/usr/bin/systemctl','restart','console-mcp-candidate-check.service'],check=True,timeout=60,stdout=subprocess.DEVNULL)
  assert show('console-mcp-candidate-check.service','ActiveState')=='active'
  probe=int(show('console-mcp-candidate-check.service','MainPID'))
  health=rpc(probe,reg['probePort'],'read_.system.console.health')
  manifest=json.loads((STORE_SELECTOR(B)/reg['candidate']/'release.json').read_text())
  assert manifest['sourceCommit']==reg['sourceSHA'] and health['buildFingerprint']==manifest['buildFingerprint']
  assert health['canonicalRegistryFingerprint']==s['registryFingerprint'],'candidate command registry drift'
  result=rpc(probe,reg['probePort'],'write.web.browser.bind',{'browserSession':'visible','targetId':(B/'target-id').read_text().strip()})
  assert result.get('ok') and result.get('status')=='WEB_TARGET_BOUND',str(result.get('nonJsonToolError','sandbox browser bind failed'))
  assert result['visible_session']['visibility_verified'] and result['visible_session']['user_interaction_ready']
  # Browser inventory must remain stable through the test.
  assert browser()==actual
  queue()
 elif mode in ('post','rollback'):
  expected=json.loads((STORE_SELECTOR(B)/reg['candidate' if mode=='post' else 'rollback']/'release.json').read_text())['buildFingerprint']
  h=None
  for i in range(20):
   try:h=rpc(pid,3334,'read_.system.console.health');break
   except Exception:time.sleep(1)
  assert h['ok'] and h['pid']==pid and h['buildFingerprint']==expected
  if mode=='post':
   proof=json.loads((B/'sandbox-result.json').read_text())
   assert h['canonicalRegistryFingerprint']==proof['registryFingerprint'],'production command registry drift'
  assert env(pid).get('CONSOLE_MCP_INTERACTIVE_UID')=='1000'
  if mode=='post':
   target=(B/'target-id').read_text().strip()
   assert agent('verify',targetId=target)['ok']
   binds=[]
   for i in range(2):
    result=rpc(pid,3334,'write.web.browser.bind',{'browserSession':'visible','targetId':target})
    assert result['ok'] and result['status']=='WEB_TARGET_BOUND'
    assert result['visible_session']['visibility_verified'] and result['visible_session']['user_interaction_ready']
    binds.append({'ok':True,'targetId':target,'status':result['status']})
   (B/'live-bind-acceptance.json').write_text(json.dumps(binds,indent=2))
  assert browser()==actual
  print(json.dumps({'newPid':pid,'buildFingerprint':h['buildFingerprint']}))
 else:raise RuntimeError('invalid gate mode')
 print('GATES_PASS_'+mode.upper())
if __name__=='__main__':main()
