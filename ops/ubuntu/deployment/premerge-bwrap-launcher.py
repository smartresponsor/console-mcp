#!/usr/bin/python3
"""Independently installed root launcher. Candidate bytes run only after irreversible UID/capability drop."""
import argparse
import ctypes as C
import errno
import json
import os
from pathlib import Path
import re
import runpy
import stat
import subprocess
import tempfile

BASE=Path('/opt/console-mcp-deploy')
EVIDENCE=BASE/'premerge-evidence'
INPUT=BASE/'premerge-inputs'
BWRAP='/usr/bin/bwrap'
SET_PRIV='/usr/bin/setpriv'
PY='/usr/bin/python3'
NODE='/usr/bin/node'
ROLES={'owner':1000,'engine':993,'wire':993,'denied':1000,'build':993,'source':993}
NAMESPACES=('pid','mnt','net','ipc','uts','cgroup')
ENV={'PATH':'/usr/bin:/bin','HOME':'/tmp','LC_ALL':'C'}

def protected(path,directory=False):
    p=Path(path)
    if not p.is_absolute() or '..' in p.parts:raise ValueError('BWRAP_PATH')
    for part in (*reversed(p.parents),p):
        st=part.lstat()
        if st.st_uid!=0 or st.st_mode&0o022 or stat.S_ISLNK(st.st_mode):
            raise PermissionError('BWRAP_UNTRUSTED_PATH')
        if part!=p or directory:
            if not stat.S_ISDIR(st.st_mode):raise ValueError('BWRAP_DIRECTORY')
        elif not stat.S_ISREG(st.st_mode) or st.st_nlink!=1:raise ValueError('BWRAP_FILE')
    return p

def private_mount(path,uid,mode):
    p=Path(path);protected(p.parent,True)
    st=p.lstat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid!=uid or st.st_gid!=1001 or stat.S_IMODE(st.st_mode)!=mode:
        raise PermissionError('BWRAP_WRITABLE_MOUNT')
    return p

def load_plan(path):
    p=protected(path)
    run=p.parent
    if run.parent!=EVIDENCE or not re.fullmatch(r'm7-[a-z0-9_]{8}',run.name) or stat.S_IMODE(run.stat().st_mode)!=0o700:
        raise PermissionError('BWRAP_RUN')
    if not re.fullmatch(r'launch-(owner|engine|wire|denied|build|source)\.json',p.name) or stat.S_IMODE(p.stat().st_mode)!=0o600:
        raise PermissionError('BWRAP_PLAN')
    with p.open('rb') as stream:raw=stream.read(65537)
    if len(raw)>65536:raise ValueError('BWRAP_PLAN_LIMIT')
    cfg=json.loads(raw,object_pairs_hook=unique)
    if type(cfg) is not dict or set(cfg)!={'role','artifact','command','env'} or p.name!='launch-'+cfg['role']+'.json':
        raise ValueError('BWRAP_PLAN')
    role=cfg['role']
    if role not in ROLES or type(cfg['command']) is not list or not cfg['command'] or any(type(v) is not str or '\0' in v for v in cfg['command']):
        raise ValueError('BWRAP_ROLE')
    if cfg['command'][0] not in (PY,NODE):raise ValueError('BWRAP_COMMAND')
    if role=='source':
        c=cfg['command']
        if len(c)!=9 or c[:6]!=[PY,'-I','-B','/source-input/admission.py','--parse-source','--sha'] or not re.fullmatch('[a-f0-9]{40}',c[6]) or c[7]!='--signer' or not re.fullmatch(r'SHA256:[A-Za-z0-9+/]{43}',c[8]):raise ValueError('BWRAP_SOURCE_COMMAND')
    env=cfg['env']
    keys={'CONSOLE_MCP_PRESERVATION_SOCKET','CONSOLE_MCP_PRESERVATION_BUNDLE_SHA256','CONSOLE_MCP_PRESERVATION_CONFIG_SHA256'}
    if type(env) is not dict or (role=='engine' and set(env)!=keys) or (role!='engine' and env):
        raise ValueError('BWRAP_ENV')
    if role=='engine' and (env['CONSOLE_MCP_PRESERVATION_SOCKET']!='/fixture/s' or any(type(env[k]) is not str or not re.fullmatch('[a-f0-9]{64}',env[k]) for k in keys-{'CONSOLE_MCP_PRESERVATION_SOCKET'})):
        raise ValueError('BWRAP_ENV')
    if role in ('owner','engine','wire','denied'):
        artifact=protected(Path(cfg['artifact']),True)
        if artifact!=run/'artifact' and not (artifact.name=='artifact' and artifact.parent.parent==INPUT and re.fullmatch('[a-f0-9]{40}',artifact.parent.name)):
            raise PermissionError('BWRAP_ARTIFACT')
    elif cfg['artifact'] is not None:raise ValueError('BWRAP_ARTIFACT')
    return run,cfg

def unique(pairs):
    d={}
    for k,v in pairs:
        if k in d:raise ValueError('BWRAP_DUPLICATE_KEY')
        d[k]=v
    return d

class ArgCmp(C.Structure):
    _fields_=[('arg',C.c_uint),('op',C.c_int),('datum_a',C.c_uint64),('datum_b',C.c_uint64)]

def seccomp_program(fd):
    """Install post-namespace filter via bwrap; no host-wide seccomp changes."""
    lib=C.CDLL('libseccomp.so.2',use_errno=True)
    lib.seccomp_init.argtypes=[C.c_uint32];lib.seccomp_init.restype=C.c_void_p
    lib.seccomp_release.argtypes=[C.c_void_p]
    lib.seccomp_syscall_resolve_name.argtypes=[C.c_char_p];lib.seccomp_syscall_resolve_name.restype=C.c_int
    lib.seccomp_rule_add_array.argtypes=[C.c_void_p,C.c_uint32,C.c_int,C.c_uint,C.POINTER(ArgCmp)]
    lib.seccomp_rule_add_array.restype=C.c_int
    lib.seccomp_export_bpf.argtypes=[C.c_void_p,C.c_int];lib.seccomp_export_bpf.restype=C.c_int
    ctx=lib.seccomp_init(0x7fff0000)
    if not ctx:raise RuntimeError('BWRAP_SECCOMP_INIT')
    def deny(name,*cmp,code=errno.EPERM):
        nr=lib.seccomp_syscall_resolve_name(name.encode())
        if nr<0:raise RuntimeError('BWRAP_SECCOMP_UNKNOWN:'+name)
        args=(ArgCmp*len(cmp))(*cmp) if cmp else None
        if lib.seccomp_rule_add_array(ctx,0x00050000|code,nr,len(cmp),args)!=0:
            raise RuntimeError('BWRAP_SECCOMP_RULE:'+name)
    try:
        for name in ('unshare','setns','mount','umount2','pivot_root','chroot','open_tree','move_mount','fsopen','fsconfig','fsmount','fspick','mount_setattr',
                     'ptrace','process_vm_readv','process_vm_writev','pidfd_getfd','pidfd_send_signal','bpf','perf_event_open',
                     'keyctl','add_key','request_key','io_uring_setup','io_uring_enter','io_uring_register','userfaultfd',
                     'kexec_load','kexec_file_load','reboot','swapon','swapoff','init_module','finit_module','delete_module'):
            deny(name)
        # clone3 cannot be safely inspected by classic BPF; ENOSYS allows
        # pthread/Node fallback to clone. Deny all namespace flags in clone.
        deny('clone3',code=errno.ENOSYS)
        for flag in (0x00020000,0x02000000,0x04000000,0x08000000,0x10000000,0x20000000,0x40000000,0x00000080):
            deny('clone',ArgCmp(0,7,flag,flag))
        for name in ('socket','socketpair'):
            deny(name,ArgCmp(0,1,1,0)) # family != AF_UNIX
        if lib.seccomp_export_bpf(ctx,fd)!=0:raise RuntimeError('BWRAP_SECCOMP_EXPORT')
    finally:lib.seccomp_release(ctx)
    os.lseek(fd,0,os.SEEK_SET)

VERIFY="""import json,os,sys
uid=int(sys.argv[1]);host=json.loads(sys.argv[2]);cmd=json.loads(sys.argv[3])
def require(ok):
 if not ok:raise SystemExit('BWRAP_EFFECTIVE_ISOLATION_FAILED')
require(os.getpid()==1 and os.getresuid()==(uid,uid,uid) and os.getresgid()==(1001,1001,1001) and not os.getgroups())
s=dict(line.split(':',1) for line in open('/proc/self/status') if ':' in line)
require(s['NoNewPrivs'].strip()=='1' and s['Seccomp'].strip()=='2')
require(all(int(s[k].strip(),16)==0 for k in ('CapInh','CapPrm','CapEff','CapBnd','CapAmb')))
require(all(os.readlink('/proc/self/ns/'+n)!=v for n,v in host.items()))
require(not os.path.exists('/home/alex') and not os.path.exists('/run/console-mcp-release') and not os.path.exists('/opt/console-mcp-deploy'))
os.execve(cmd[0],cmd,dict(os.environ))
"""

def arguments(run,cfg,fd,host):
    role=cfg['role'];uid=ROLES[role]
    # No host user namespace mapping: SO_PEERCRED sees actual host UIDs.
    # Only fixed setpriv executes with setup caps. All candidate processes
    # execute after real/effective/saved UID/GID and every cap set are checked.
    cmd=[BWRAP,'--unshare-pid','--as-pid-1','--unshare-net','--unshare-ipc','--unshare-uts',
         '--unshare-cgroup','--die-with-parent','--new-session','--clearenv',
         '--cap-drop','ALL','--cap-add','CAP_SETUID','--cap-add','CAP_SETGID','--cap-add','CAP_SETPCAP',
         '--ro-bind','/usr/bin','/usr/bin','--ro-bind','/usr/lib','/usr/lib',
         '--ro-bind','/usr/lib64','/usr/lib64','--ro-bind','/usr/share','/usr/share',
         '--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64',
         '--proc','/proc','--dev','/dev','--perms','01777','--tmpfs','/tmp','--dir','/run','--dir','/home',
         '--dir','/etc','--dir','/opt','--chdir','/']
    if role in ('owner','engine','wire','denied'):
        cmd+=['--ro-bind',str(protected(run/'etc',True)),'/etc/console-mcp',
              '--ro-bind',str(protected(run/'opt',True)),'/opt/console-mcp',
              '--ro-bind',cfg['artifact'],'/artifact',
              '--bind' if role=='owner' else '--ro-bind',str(private_mount(run/'owner',1000,0o2710)),'/fixture']
    if role=='build':
        for name in ('work','cache'):
            cmd+=['--bind',str(private_mount(run/'private-build'/name,993,0o700)),'/'+name]
    if role=='source':
        cmd+=['--ro-bind',str(protected(run/'source-input',True)),'/source-input',
              '--bind',str(private_mount(run/'private-source'/'work',993,0o700)),'/work']
    for k,v in {**ENV,**cfg['env']}.items():cmd+=['--setenv',k,v]
    cmd+=['--remount-ro','/','--seccomp',str(fd),'--',SET_PRIV,'--reuid='+str(uid),'--regid=1001','--clear-groups',
          '--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all','--no-new-privs','--',
          PY,'-I','-B','-c',VERIFY,str(uid),json.dumps(host),json.dumps(cfg['command'])]
    return cmd

def bounded_tmpfs(path,maximum):
    # Prove the exact per-unit mount, not an ordinary writable host path.
    rows=Path('/proc/self/mountinfo').read_text().splitlines()
    matches=[line.split(' - ',1) for line in rows if len(line.split())>5 and line.split()[4]==str(path)]
    if len(matches)!=1 or matches[0][1].split()[0]!='tmpfs':raise PermissionError('BWRAP_TMPFS_REQUIRED')
    st=os.statvfs(path)
    if st.f_blocks*st.f_frsize>maximum:raise PermissionError('BWRAP_TMPFS_LIMIT')
    options=set(matches[0][0].split()[5].split(','))
    if not {'rw','nodev','nosuid','noexec'}<=options:raise PermissionError('BWRAP_TMPFS_OPTIONS')

def prepare_build(run):
    private=protected(run/'private-build',True)
    bounded_tmpfs(private,1024*1024*1024)
    if stat.S_IMODE(private.stat().st_mode)!=0o700:raise PermissionError('BWRAP_BUILD_TMPFS_MODE')
    # Only the independent installed operator supplies the copy routine.
    installed=protected(BASE/'premerge-admission.py')
    copy=runpy.run_path(str(installed),run_name='installed_premerge_copy')['inventory_copy']
    copy(protected(run/'artifact',True),private/'work',owner=993,limit=512*1024*1024)
    copy(protected(run/'cache-input',True),private/'cache',owner=993,limit=512*1024*1024)
    return copy

def proof(run,host):
    import contextlib,time
    run=protected(run,True)
    fixture=private_mount(run/'owner',1000,0o2710)
    bounded_tmpfs(fixture,64*1024*1024)
    for name in ('repo','reports'):
        p=fixture/name;p.mkdir(mode=0o700);os.chown(p,1000,1001);p.chmod(0o700)
    plans={role:load_plan(run/('launch-'+role+'.json'))[1] for role in ('owner','denied','engine','wire')}
    if len({p['artifact'] for p in plans.values()})!=1:raise ValueError('BWRAP_PROOF_ARTIFACT_MISMATCH')
    with contextlib.ExitStack() as stack:
        program=stack.enter_context(tempfile.TemporaryFile(dir=run));seccomp_program(program.fileno())
        def start(role):
            out=stack.enter_context(tempfile.TemporaryFile(dir=run));err=stack.enter_context(tempfile.TemporaryFile(dir=run))
            os.lseek(program.fileno(),0,os.SEEK_SET)
            proc=subprocess.Popen(arguments(run,plans[role],program.fileno(),host),env=ENV,pass_fds=(program.fileno(),),
                                  stdin=subprocess.DEVNULL,stdout=out,stderr=err)
            return proc,out,err
        def finish(role):
            proc,out,err=start(role)
            try:code=proc.wait(timeout=55)
            except subprocess.TimeoutExpired:
                proc.kill();proc.wait(timeout=5);raise
            if code:
                err.seek(max(0,os.fstat(err.fileno()).st_size-4096));os.write(2,err.read(4096))
                raise RuntimeError('BWRAP_PROOF_ROLE_FAILED:'+role)
            out.seek(0);raw=out.read(65537)
            if len(raw)>65536:raise ValueError('BWRAP_PROOF_OUTPUT_LIMIT')
            return raw
        owner,_,owner_err=start('owner')
        try:
            path=fixture/'s'
            for _ in range(100):
                if owner.poll() is not None:
                    owner_err.seek(0);os.write(2,owner_err.read(4096));raise RuntimeError('BWRAP_OWNER_EXITED')
                if path.exists():break
                time.sleep(.1)
            s=path.lstat()
            if not stat.S_ISSOCK(s.st_mode) or s.st_uid!=1000 or s.st_gid!=1001 or stat.S_IMODE(s.st_mode)!=0o660:
                raise ValueError('BWRAP_SOCKET_IDENTITY')
            if finish('denied').strip()!=b'PREMERGE_OWNER_DENIED_PASS':raise ValueError('BWRAP_OWNER_DENIAL')
            engine=json.loads(finish('engine'));wire=json.loads(finish('wire'))
            if owner.poll() is not None:raise RuntimeError('BWRAP_OWNER_EXITED')
            receipt=dict(ownerDenied=True,socketUid=s.st_uid,socketGid=s.st_gid,engine=engine,wire=wire)
        finally:
            if owner.poll() is None:
                owner.terminate()
                try:owner.wait(timeout=5)
                except subprocess.TimeoutExpired:owner.kill();owner.wait(timeout=5)
        print(json.dumps(receipt,separators=(',',':')),flush=True)

def main():
    parser=argparse.ArgumentParser();which=parser.add_mutually_exclusive_group(required=True)
    which.add_argument('--plan');which.add_argument('--proof');a=parser.parse_args()
    if os.geteuid()!=0:raise SystemExit('BWRAP_ROOT_OPERATOR_REQUIRED')
    protected(Path(__file__))
    for path in (BWRAP,SET_PRIV,PY,NODE):
        protected(Path(path).resolve(strict=True))
    host={n:os.readlink('/proc/self/ns/'+n) for n in NAMESPACES}
    if a.proof:
        proof(Path(a.proof),host);return
    run,cfg=load_plan(a.plan)
    role=cfg['role']
    if role not in ('source','build'):raise ValueError('BWRAP_BUILD_PLAN_REQUIRED')
    scratch=run/('private-'+role)
    if role=='source':
        bounded_tmpfs(protected(scratch,True),1024*1024*1024)
        if stat.S_IMODE(scratch.stat().st_mode)!=0o700:raise PermissionError('BWRAP_SOURCE_TMPFS_MODE')
        work=scratch/'work';work.mkdir(mode=0o700);os.chown(work,993,1001);work.chmod(0o700)
        copy=runpy.run_path(str(protected(BASE/'premerge-admission.py')),run_name='installed_premerge_copy')['inventory_copy']
    else:copy=prepare_build(run)
    # Candidate streams are never captured unbounded in the root controller.
    # Build logs reside on the bounded tmpfs; proof streams have a 1 MiB unit
    # file size limit. Only the trusted launcher forwards a bounded result.
    with tempfile.TemporaryFile(dir=scratch) as program,tempfile.TemporaryFile(dir=scratch) as out,tempfile.TemporaryFile(dir=scratch) as err:
        seccomp_program(program.fileno())
        result=subprocess.run(arguments(run,cfg,program.fileno(),host),env=ENV,pass_fds=(program.fileno(),),
                              stdin=subprocess.DEVNULL,stdout=out,stderr=err,timeout=210 if role=='source' else 600)
        if result.returncode:
            err.seek(max(0,os.fstat(err.fileno()).st_size-4096))
            os.write(2,err.read(4096));raise SystemExit(result.returncode)
        # PID 1 exit destroys its namespace and descendants. Copy only
        # regular outputs after the isolated process has stopped.
        if role=='source':
            out.seek(0)
            if out.read(65537).strip()!=b'PREMERGE_SIGNED_SOURCE_PASS':raise ValueError('BWRAP_SOURCE_PROOF')
            copy(scratch/'work'/'snapshot',run/'source-snapshot',limit=512*1024*1024)
            print('PREMERGE_SIGNED_SOURCE_PASS',flush=True)
        else:
            copy(scratch/'work'/'dist',run/'artifact'/'dist',limit=512*1024*1024)
            print('PREMERGE_OFFLINE_BUILD_PASS',flush=True)
    raise SystemExit(0)

if __name__=='__main__':main()
