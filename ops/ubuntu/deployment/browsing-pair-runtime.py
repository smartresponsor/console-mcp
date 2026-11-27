"""First paired rollout plan for the existing deployment controller.

This module is intentionally pure except for reading protected configuration
and live process evidence. It never changes units, environment or services.
The cutover controller must still admit quiescence and rollback separately.
"""
import hashlib
import os
from pathlib import Path
import re
import stat

BASE=Path('/opt/console-mcp-deploy')
LEASE=Path('/run/console-mcp-browser-leases')
CONSOLE='console-mcp.service'
WORKER='browser-mcp-worker.service'
WATCHDOG='console-mcp-watchdog.service'
SHA=re.compile('[a-f0-9]{40}')
PIN=re.compile('[a-f0-9]{64}')
CONSOLE_ENV=BASE/'paired-console.env'
WORKER_ENV=BASE/'paired-browsing.env'
WATCHDOG_ENV=BASE/'paired-watchdog.env'
DROP='91-paired-runtime.conf'
DEFINITIONS='mcp-server/src/web-domain-tool-definitions.cjs'
LEASE_NAMES={'CONSOLE_MCP_VISIBLE_OS_LEASES':'required','CONSOLE_MCP_VISIBLE_LEASE_ROOT':str(LEASE)}

def require(ok,msg):
    if not ok:raise ValueError(msg)

def protected_file(p,uid=0):
    s=p.lstat()
    require(stat.S_ISREG(s.st_mode) and s.st_uid==uid and s.st_nlink==1 and not s.st_mode&0o022,'PAIR_RUNTIME_UNPROTECTED')
    return s

def path_value(p):
    s=str(p)
    require(s.startswith('/') and re.fullmatch(r'/[A-Za-z0-9_./-]+',s) and '..' not in Path(s).parts,'PAIR_RUNTIME_PATH')
    return s

def env_bytes(values):
    require(all(re.fullmatch('[A-Z0-9_]+',k) and re.fullmatch('[A-Za-z0-9_./:-]+',v) for k,v in values.items()),'PAIR_RUNTIME_ENV')
    return ''.join(k+'='+v+'\n' for k,v in sorted(values.items())).encode()

def dropin(env,extra=()):
    return ('[Service]\nEnvironmentFile='+path_value(env)+'\nReadWritePaths='+str(LEASE)+'\n'+'\n'.join(extra)+'\n').encode()

def render(console, browsing, pair):
    c,b=pair.get('consoleSHA'),pair.get('browsingSHA')
    require(isinstance(c,str) and SHA.fullmatch(c) and isinstance(b,str) and SHA.fullmatch(b),'PAIR_RUNTIME_SHA')
    require(pair.get('status')=='BROWSING_PAIR_INVENTORY_PASS' and pair.get('activationEligible') is False,'PAIR_RUNTIME_BINDING')
    require(all(isinstance(pair.get(k),str) and PIN.fullmatch(pair[k]) for k in ('consoleManifestSha256','browsingManifestSha256','leaseModuleSha256','workerSha256','policySha256')),'PAIR_RUNTIME_PIN')
    require(console.name==c and browsing==BASE/'browsing-releases'/c/b,'PAIR_RUNTIME_ROOT')
    cp=path_value(console);bp=path_value(browsing)
    console_values=dict(LEASE_NAMES,BROWSER_MCP_BROWSER_WORKER_URL='http://127.0.0.1:8791',BROWSER_MCP_CORE_DOMAIN_DEFINITIONS_PATH=bp+'/'+DEFINITIONS)
    worker_values=dict(LEASE_NAMES,BROWSER_MCP_CONSOLE_ROOT=cp,PORT='8791',BROWSER_MCP_WORKER_PORT='8791',BROWSER_MCP_REMOTE_DEBUGGING_PORT='9223',BROWSER_MCP_HEADLESS='false',BROWSER_MCP_EXTERNAL_VISIBLE_BROWSER='true',BROWSER_MCP_BROWSER_CHANNEL='msedge',BROWSER_MCP_USER_DATA_DIR='/var/lib/console-mcp-browser/edge-profile')
    # Preserve observer behavior, never allow recovery during shared lease mode.
    watcher_values=dict(LEASE_NAMES,CONSOLE_MCP_WATCHDOG_ALLOW_RESTARTS='false',CONSOLE_MCP_WATCHDOG_ALLOW_BROWSER_CLEANUP='false')
    plan={
      CONSOLE_ENV:env_bytes(console_values),WORKER_ENV:env_bytes(worker_values),WATCHDOG_ENV:env_bytes(watcher_values),
      Path('/etc/systemd/system')/(CONSOLE+'.d')/DROP:dropin(CONSOLE_ENV),
      Path('/etc/systemd/system')/(WORKER+'.d')/DROP:dropin(WORKER_ENV,('ExecStart=','ExecStart=/usr/bin/node '+bp+'/playwright-worker/src/worker.js','Restart=no')),
      Path('/etc/systemd/system')/(WATCHDOG+'.d')/DROP:dropin(WATCHDOG_ENV,('ExecStart=','ExecStart=/usr/bin/bash '+cp+'/ops/ubuntu/script/watchdog.sh')),
    }
    return plan

def first_rollout_baseline(show,exists):
    # This scope cannot safely drain an arbitrary legacy/active worker.
    require(show(WORKER,'LoadState')=='loaded','PAIR_WORKER_UNIT_MISSING')
    require(show(WORKER,'ActiveState')=='inactive' and show(WORKER,'MainPID')=='0','PAIR_FIRST_ROLLOUT_WORKER_NOT_INACTIVE')
    require(show(CONSOLE,'ActiveState')=='active' and show(CONSOLE,'MainPID').isdigit() and int(show(CONSOLE,'MainPID'))>0,'PAIR_CONSOLE_NOT_ACTIVE')
    for u in (CONSOLE,WORKER):
        require(not show(u,'BindsTo') and not show(u,'PartOf'),'PAIR_UNEXPECTED_UNIT_COUPLING')
    require(show(WATCHDOG,'ActiveState')=='inactive','PAIR_WATCHDOG_IN_FLIGHT')
    require(not exists(LEASE),'PAIR_LEASE_ROOT_ALREADY_EXISTS')
    return {'consolePid':int(show(CONSOLE,'MainPID')),'workerState':'inactive','watchdogState':'inactive','leaseRootExisted':False}

def initial_plan(console,browsing,pair,show,exists):
    baseline=first_rollout_baseline(show,exists)
    rendered=render(console,browsing,pair)
    require(not any(exists(p) for p in rendered),'PAIR_DROPIN_ALREADY_EXISTS')
    return {'schemaVersion':1,'pair':pair,'baseline':baseline,'files':{str(p):hashlib.sha256(raw).hexdigest() for p,raw in rendered.items()},'activationEligible':False}

def verify_plan(expected,console,browsing,pair,show,exists):
    actual=initial_plan(console,browsing,pair,show,exists)
    require(actual==expected,'PAIR_RUNTIME_PLAN_DRIFT')
    return actual

def verify_effective(console,browsing,pair,console_proc,worker_proc):
    # Read-only caller obtains these from authenticated systemd PIDs and
    # /proc/<pid>/root, rather than trusting a worker self-report.
    c,w=console_proc,worker_proc
    require(c.get('uid')==w.get('uid')==993,'PAIR_EFFECTIVE_UID')
    require(c.get('pid')!=w.get('pid') and all(type(x.get('pid')) is int and x['pid']>0 for x in (c,w)),'PAIR_EFFECTIVE_PID')
    require(c.get('leaseIdentity') and c['leaseIdentity']==w.get('leaseIdentity'),'PAIR_EFFECTIVE_LEASE_INODE')
    require(c.get('leaseMode')==w.get('leaseMode')==0o700,'PAIR_EFFECTIVE_LEASE_MODE')
    require(c.get('leaseUid')==w.get('leaseUid')==993,'PAIR_EFFECTIVE_LEASE_OWNER')
    ce,we=c['env'],w['env']
    require(all(e.get(k)==v for e in (ce,we) for k,v in LEASE_NAMES.items()),'PAIR_EFFECTIVE_LEASE_ENV')
    require(ce.get('BROWSER_MCP_BROWSER_WORKER_URL')=='http://127.0.0.1:8791' and ce.get('BROWSER_MCP_CORE_DOMAIN_DEFINITIONS_PATH')==str(browsing/DEFINITIONS),'PAIR_EFFECTIVE_CONSOLE_ROUTE')
    require(we.get('BROWSER_MCP_CONSOLE_ROOT')==str(console) and we.get('PORT')==we.get('BROWSER_MCP_WORKER_PORT')=='8791' and we.get('BROWSER_MCP_REMOTE_DEBUGGING_PORT')=='9223' and we.get('BROWSER_MCP_EXTERNAL_VISIBLE_BROWSER')=='true' and we.get('BROWSER_MCP_HEADLESS')=='false','PAIR_EFFECTIVE_WORKER_ROUTE')
    require(w.get('argv')==['/usr/bin/node',str(browsing/'playwright-worker/src/worker.js')],'PAIR_EFFECTIVE_WORKER_ENTRYPOINT')
    token=ce.get('BROWSER_MCP_BROWSER_WORKER_TOKEN','')
    drain=we.get('BROWSER_MCP_WORKER_DRAIN_TOKEN','')
    require(len(token)>=32 and token==we.get('BROWSER_MCP_BROWSER_WORKER_TOKEN') and len(drain)>=32 and drain!=token,'PAIR_EFFECTIVE_AUTH')
    require(c.get('lockModuleSha256')==w.get('lockModuleSha256')==pair['leaseModuleSha256'] and w.get('workerSha256')==pair['workerSha256'],'PAIR_EFFECTIVE_MODULE')
    return {'status':'PAIR_EFFECTIVE_RUNTIME_PASS','consolePid':c['pid'],'workerPid':w['pid'],'leaseIdentity':c['leaseIdentity'],'activationEligible':False}
