#!/usr/bin/python3
"""Read-only incumbent ingress inventory. No secrets, signals, or service changes."""
import json,os,re,subprocess
from pathlib import Path
UNIT='console-mcp.service'
EXPECTED='473144da9d50dcce16590fa81b50b411d6ac3dc2'
LIVE='/home/alex/smartresponse/mcp/console-mcp'
def run(*args):
    return subprocess.check_output(args,text=True,timeout=12)
def show(unit,prop):
    return run('/usr/bin/systemctl','show',unit,'--value','-p',prop).strip()
def identity(pid):
    p=Path('/proc')/str(pid)
    raw=(p/'stat').read_text()
    return {'pid':pid,'uid':p.stat().st_uid,'startTicks':raw[raw.rfind(')')+2:].split()[19]}
def socket_rows(pid,kind):
    text=run('/usr/bin/ss','-H',kind,'-p')
    rows=[]
    for line in text.splitlines():
        if not re.search(r'\bpid='+str(pid)+r'[,)]',line):continue
        fields=line.split()
        if kind=='-ltn':
            if len(fields)>=5:rows.append(fields[3])
        elif kind=='-lxn':
            if len(fields)>=6 and fields[4].startswith('/'):rows.append(fields[4])
    return sorted(set(rows))
def proc_socket_count(pid):
    p=Path('/proc')/str(pid)/'fd'
    return sum(os.readlink(f).startswith('socket:[') for f in p.iterdir() if f.is_symlink())
def main():
    pid=int(show(UNIT,'MainPID'))
    if pid<=0:raise RuntimeError('INCUMBENT_NOT_ACTIVE')
    before=identity(pid)
    bindings=show(UNIT,'BindReadOnlyPaths').split()
    sources=[x.split(':')[0] for x in bindings if len(x.split(':'))>=2 and x.split(':')[1]==LIVE+'/dist']
    if len(sources)!=1 or Path(sources[0]).parent.name!=EXPECTED:raise RuntimeError('INCUMBENT_RELEASE_DRIFT')
    # Process environment is inspected for socket locators only, never tokens.
    env=dict(x.split(b'=',1) for x in (Path('/proc')/str(pid)/'environ').read_bytes().split(b'\0') if b'=' in x)
    locators={}
    for name in ('CONSOLE_MCP_NETWORK_TUNNEL_SOCKET','CONSOLE_MCP_LOOPING_TUNNEL_SOCKET','CONSOLE_MCP_REPO_TUNNEL_SOCKET'):
        value=env.get(name.encode(),b'').decode()
        if value:
            if not re.fullmatch(r'/run/[a-zA-Z0-9_./-]+',value):raise RuntimeError('UNEXPECTED_SOCKET_LOCATOR')
            locators[name]=value
    tcp=socket_rows(pid,'-ltn');unix=socket_rows(pid,'-lxn')
    units={}
    for u in ('console-mcp.service','browser-mcp-worker.service','console-mcp-browser.service','console-mcp-visible-worker.service','console-mcp-grants-web-worker.service','console-mcp-watchdog.service','console-mcp-watchdog.timer','console-mcp-release-broker.service'):
        units[u]={'state':show(u,'ActiveState'),'pid':show(u,'MainPID')}
    after=identity(pid)
    if before!=after or int(show(UNIT,'MainPID'))!=pid:raise RuntimeError('INCUMBENT_IDENTITY_DRIFT')
    print(json.dumps({'status':'LEGACY_INGRESS_INVENTORY_ONLY','sourceSHA':EXPECTED,'identity':before,'tcpListeners':tcp,'unixListeners':unix,'configuredFacadeSockets':locators,'socketFDCount':proc_socket_count(pid),'units':units,'productionChanged':False,'drainVerified':False,'activationEligible':False},indent=2))
if __name__=='__main__':main()
