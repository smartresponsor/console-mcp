#!/usr/bin/python3
"""Pinned Console MCP switch. Root only; no caller-controlled paths or commands."""
import fcntl, hashlib, json, os, pathlib, subprocess, sys, time
BASE = pathlib.Path('/opt/console-mcp-deploy')
DROP = pathlib.Path('/etc/systemd/system/console-mcp.service.d/90-versioned-runtime.conf')
UNIT = 'console-mcp.service'
PARTS = ('dist','node_modules','tool','policy','ops','config','src','bin','package.json','package-lock.json')
LIVE = '/home/alex/smartresponse/mcp/console-mcp'

def atomic(path, data, mode=0o600):
    tmp = path.with_name(path.name + '.tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as out:
        out.write(data); out.flush(); os.fsync(out.fileno())
    os.chmod(tmp, mode); os.replace(tmp, path)
    fd = os.open(path.parent, os.O_DIRECTORY); os.fsync(fd); os.close(fd)

def verify(tree):
    for sealed in (tree, tree / 'release.json'):
        st = sealed.lstat()
        if sealed.is_symlink() or st.st_uid != 0 or st.st_mode & 0o022: raise RuntimeError('unsealed release root/manifest')
    manifest = json.loads((tree / 'release.json').read_text())
    expected = manifest['files']; actual = {}
    for p in tree.rglob('*'):
        if p.name == 'release.json' and p.parent == tree: continue
        st = p.lstat()
        if st.st_uid != 0 or (not p.is_symlink() and st.st_mode & 0o022): raise RuntimeError('unsealed release member')
        if p.is_symlink():
            if not p.resolve().is_relative_to(tree.resolve()): raise RuntimeError('escaping release symlink')
            actual[str(p.relative_to(tree))] = 'link:' + os.readlink(p)
        elif p.is_file(): actual[str(p.relative_to(tree))] = hashlib.sha256(p.read_bytes()).hexdigest()
    if expected != actual: raise RuntimeError('release inventory/hash mismatch')
    return manifest

def override(tree):
    lines = ['[Service]', 'Environment=CONSOLE_MCP_MANAGED_RUNTIME=systemd CONSOLE_MCP_INTERACTIVE_UID=1000']
    lines += ['BindReadOnlyPaths=' + str(tree / n) + ':' + LIVE + '/' + n for n in PARTS if (tree / n).exists()]
    return ('\n'.join(lines)+'\n').encode()

def ctl(*args): subprocess.run(['/usr/bin/systemctl', *args],check=True,timeout=45,stdout=subprocess.DEVNULL)
def restart(tree):
    atomic(DROP,override(tree),0o644); ctl('daemon-reload'); ctl('restart',UNIT)

def recover(reg):
    state = BASE / 'transaction.json'
    if state.exists() and json.loads(state.read_text())['phase'] != 'committed':
        old = BASE / 'releases' / reg['rollback']; verify(old); restart(old)
        subprocess.run(['/usr/bin/python3',str(BASE/'gates.py'),'rollback'],check=True,timeout=45)
        atomic(state,json.dumps({'phase':'rolled_back','at':time.time()}).encode())
        # A rolled-back journal is terminal, never restart repeatedly on boot.
        state.rename(BASE / 'last-rollback.json')
        print('ROLLBACK_COMPLETE')

def apply(reg):
    new = BASE/'releases'/reg['candidate']; old = BASE/'releases'/reg['rollback']
    verify(new); verify(old)
    # Gates are refreshed by a fixed root-owned verifier, never a caller-supplied READY flag.
    subprocess.run(['/usr/bin/python3',str(BASE/'gates.py'),'pre'],check=True,timeout=90)
    atomic(BASE/'transaction.json',json.dumps({'phase':'pending','at':time.time()}).encode())
    try:
        restart(new)
        subprocess.run(['/usr/bin/python3',str(BASE/'gates.py'),'post'],check=True,timeout=90)
        atomic(BASE/'transaction.json',json.dumps({'phase':'committed','at':time.time()}).encode())
        print('CUTOVER_COMMITTED')
    except BaseException:
        recover(reg); raise

def main():
    if os.geteuid()!=0: raise SystemExit('root required')
    if len(sys.argv)!=2 or sys.argv[1] not in ('verify','apply','rollback','recover','status'): raise SystemExit('invalid operation')
    with (BASE/'lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        reg=json.loads((BASE/'registry.json').read_text())
        if sys.argv[1]=='verify':
            for key in ('candidate','rollback'): verify(BASE/'releases'/reg[key])
            print('SEALED_RELEASES_VERIFIED')
        elif sys.argv[1]=='apply':
            if (BASE/'transaction.json').exists() and json.loads((BASE/'transaction.json').read_text())['phase']!='committed': raise RuntimeError('recover pending transaction first')
            apply(reg)
        elif sys.argv[1]=='rollback':
            verify(BASE/'releases'/reg['rollback'])
            atomic(BASE/'transaction.json',b'{"phase":"pending"}');recover(reg)
        elif sys.argv[1]=='recover': recover(reg)
        else: print((BASE/'transaction.json').read_text() if (BASE/'transaction.json').exists() else 'NOT_STARTED')
if __name__=='__main__': main()
