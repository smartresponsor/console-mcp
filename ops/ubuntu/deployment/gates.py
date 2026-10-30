#!/usr/bin/python3
import hashlib,json,os,pathlib,re,socket,subprocess,sys,time,urllib.request
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
 p=subprocess.run(['/usr/sbin/runuser','-u','alex','--','/usr/bin/setpriv','--no-new-privs','/usr/bin/python3','-I',str(L/'ops/ubuntu/script/desktop-agent-client.py')],input=json.dumps(dict(version=1,requestId='deployment-gates',operation=op,**kw)),text=True,capture_output=True,timeout=20,check=True)
 return json.loads(p.stdout)
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
def queue():
 active=[];stale=[];checked=0
 paths=list(pathlib.Path('/var/lib/console-mcp/run/engine/task').glob('*.json'))
 for root,dirs,files in os.walk('/home/alex/smartresponse'):
  if '.console-mcp' in dirs:
   paths.extend((pathlib.Path(root)/'.console-mcp/command-run').glob('*/state.json'))
  dirs[:]=[d for d in dirs if d not in ('.git','node_modules','tmp','var','browser','profiles','.cache','.config','.console-mcp')]
 for p in paths:
  try:d=json.loads(p.read_text())
  except (ValueError,OSError):continue
  checked+=1
  if not isinstance(d,dict):continue
  if d.get('status') in ('queued','running','executing','dispatch_ready','planned','stopping'):
   pid=d.get('pid')
   if pid and not pathlib.Path('/proc/'+str(pid)).exists():stale.append(str(p))
   else:active.append(str(p))
 (B/'queue-last.json').write_text(json.dumps({'checked':checked,'active':active,'staleDeadProcessRecords':stale,'at':time.time()},indent=2))
 if active:raise RuntimeError('task queue not empty: '+str(len(active)))

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
  expected=json.loads((B/'releases'/reg['rollback']/'release.json').read_text())['buildFingerprint']
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
  manifest=json.loads((B/'releases'/reg['candidate']/'release.json').read_text())
  assert manifest['sourceCommit']==reg['sourceSHA'] and health['buildFingerprint']==manifest['buildFingerprint']
  assert health['canonicalRegistryFingerprint']==s['registryFingerprint'],'candidate command registry drift'
  result=rpc(probe,reg['probePort'],'write.web.browser.bind',{'browserSession':'visible','targetId':(B/'target-id').read_text().strip()})
  assert result.get('ok') and result.get('status')=='WEB_TARGET_BOUND',str(result.get('nonJsonToolError','sandbox browser bind failed'))
  assert result['visible_session']['visibility_verified'] and result['visible_session']['user_interaction_ready']
  # Browser inventory must remain stable through the test.
  assert browser()==actual
  queue()
 elif mode in ('post','rollback'):
  expected=json.loads((B/'releases'/reg['candidate' if mode=='post' else 'rollback']/'release.json').read_text())['buildFingerprint']
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
