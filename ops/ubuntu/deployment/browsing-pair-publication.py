"""Recoverable file publication for the first paired rollout.

No executable entrypoint, systemctl invocation or authorization. The caller
must hold the existing deployment lock, establish quiescence independently,
and record the install/restore intent in the existing durable journal.
"""
import ctypes
import hashlib
import os
from pathlib import Path
import re
import stat

BASE=Path('/opt/console-mcp-deploy')
SYSTEM=Path('/etc/systemd/system')
FILES=(BASE/'paired-console.env',BASE/'paired-browsing.env',BASE/'paired-watchdog.env',
       SYSTEM/'console-mcp.service.d/91-paired-runtime.conf',
       SYSTEM/'browser-mcp-worker.service.d/91-paired-runtime.conf',
       SYSTEM/'console-mcp-watchdog.service.d/91-paired-runtime.conf')
GEN=re.compile('[0-9a-f]{32}')
PIN=re.compile('[0-9a-f]{64}')
D=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
F=os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK

def require(ok,msg):
    if not ok:raise RuntimeError(msg)

def digest(raw):return hashlib.sha256(raw).hexdigest()

def check_plan(rendered,plan,generation):
    require(type(generation) is str and GEN.fullmatch(generation),'PAIR_PUBLICATION_GENERATION')
    require(type(rendered) is dict and set(rendered)==set(FILES),'PAIR_PUBLICATION_FILE_SET')
    require(all(type(raw) is bytes and 0<len(raw)<=65536 for raw in rendered.values()),'PAIR_PUBLICATION_BYTES')
    require(type(plan) is dict and plan.get('activationEligible') is False and plan.get('files')=={str(p):digest(raw) for p,raw in rendered.items()},'PAIR_PUBLICATION_PLAN_DRIFT')

def check_dir(fd,uid):
    s=os.fstat(fd)
    require(stat.S_ISDIR(s.st_mode) and s.st_uid==uid and not s.st_mode&0o022,'PAIR_PUBLICATION_PARENT')
    return s

def open_parent(anchor,path,uid,create=False):
    # anchor is a trusted dirfd; production callers anchor at /. Tests use
    # a private fixture root. Never follow a symlink in a path component.
    fd=os.dup(anchor)
    try:
        check_dir(fd,uid)
        parts=path.parent.parts[1:]
        for i,name in enumerate(parts):
            try:nxt=os.open(name,D,dir_fd=fd)
            except FileNotFoundError:
                require(i==len(parts)-1 and path.parent.parent==SYSTEM,'PAIR_PUBLICATION_ANCESTOR_MISSING')
                require(create,'PAIR_PUBLICATION_PARENT_MISSING')
                os.mkdir(name,0o755,dir_fd=fd)
                os.fsync(fd)
                nxt=os.open(name,D,dir_fd=fd)
                os.fchmod(nxt,0o755)
                os.fsync(nxt)
            try:check_dir(nxt,uid)
            except BaseException:os.close(nxt);raise
            os.close(fd);fd=nxt
        return fd
    except BaseException:os.close(fd);raise

def read_member(fd,name,uid,expected_mode=0o644):
    try:f=os.open(name,F,dir_fd=fd)
    except FileNotFoundError:return None
    with os.fdopen(f,'rb') as stream:
        before=os.fstat(stream.fileno())
        def stamp(s):return (s.st_dev,s.st_ino,s.st_uid,s.st_mode,s.st_nlink,s.st_size,s.st_ctime_ns,s.st_mtime_ns)
        require(stat.S_ISREG(before.st_mode) and before.st_uid==uid and before.st_nlink==1 and stat.S_IMODE(before.st_mode)==expected_mode and before.st_size<=65536,'PAIR_PUBLICATION_MEMBER')
        raw=stream.read(65537)
        require(len(raw)==before.st_size and stamp(before)==stamp(os.fstat(stream.fileno()))==stamp(os.stat(name,dir_fd=fd,follow_symlinks=False)),'PAIR_PUBLICATION_MEMBER_DRIFT')
        return raw

def temporary_name(name,generation):return '.'+name+'.pair-'+generation+'.tmp'

def cleanup_temp(fd,name,uid):
    # A crash can leave a partial stage. Its reserved generation name and
    # protected parent are the ownership boundary, not its partial bytes.
    try:s=os.stat(name,dir_fd=fd,follow_symlinks=False)
    except FileNotFoundError:return
    require(stat.S_ISREG(s.st_mode) and s.st_uid==uid and s.st_nlink==1 and stat.S_IMODE(s.st_mode) in (0o600,0o644),'PAIR_PUBLICATION_TEMP_UNTRUSTED')
    os.unlink(name,dir_fd=fd);os.fsync(fd)

def rename_noreplace(fd,src,dst):
    # Linux renameat2 is atomic and refuses replacement. No check-then-rename
    # fallback, even if the filesystem/kernel lacks this operation.
    libc=ctypes.CDLL(None,use_errno=True)
    fn=libc.renameat2
    fn.argtypes=(ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint)
    fn.restype=ctypes.c_int
    if fn(fd,os.fsencode(src),fd,os.fsencode(dst),1)!=0:
        err=ctypes.get_errno();raise OSError(err,os.strerror(err))

def publish_one(fd,name,raw,generation,uid):
    temp=temporary_name(name,generation)
    old=read_member(fd,name,uid)
    require(old is None or old==raw,'PAIR_PUBLICATION_EXISTING_DRIFT')
    cleanup_temp(fd,temp,uid)
    if old is not None:return False
    handle=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
    with os.fdopen(handle,'wb') as out:
        os.fchmod(out.fileno(),0o600)
        out.write(raw);out.flush();os.fchmod(out.fileno(),0o644);os.fsync(out.fileno())
    rename_noreplace(fd,temp,name);os.fsync(fd)
    require(read_member(fd,name,uid)==raw,'PAIR_PUBLICATION_POSTCONDITION')
    return True

def restore_one(fd,name,raw,generation,uid):
    old=read_member(fd,name,uid)
    require(old is None or old==raw,'PAIR_PUBLICATION_RESTORE_DRIFT')
    cleanup_temp(fd,temporary_name(name,generation),uid)
    if old is None:return False
    os.unlink(name,dir_fd=fd);os.fsync(fd)
    require(read_member(fd,name,uid) is None,'PAIR_PUBLICATION_RESTORE_POSTCONDITION')
    return True

def verify_all(anchor,rendered,uid,present):
    for p in FILES:
        try:fd=open_parent(anchor,p,uid)
        except RuntimeError as e:
            if not present and str(e)=='PAIR_PUBLICATION_PARENT_MISSING':continue
            raise
        try:
            old=read_member(fd,p.name,uid)
            require(old==(rendered[p] if present else None),'PAIR_PUBLICATION_VERIFY')
        finally:os.close(fd)
    return True

def preflight(anchor,rendered,generation,uid):
    # Reject every visible conflict before modifying any file. The existing
    # broker/deploy lock serializes trusted writers for the whole operation.
    for p in FILES:
        try:fd=open_parent(anchor,p,uid)
        except RuntimeError as e:
            if str(e)=='PAIR_PUBLICATION_PARENT_MISSING':continue
            raise
        try:
            old=read_member(fd,p.name,uid)
            require(old is None or old==rendered[p],'PAIR_PUBLICATION_PREFLIGHT_DRIFT')
            try:s=os.stat(temporary_name(p.name,generation),dir_fd=fd,follow_symlinks=False)
            except FileNotFoundError:continue
            require(stat.S_ISREG(s.st_mode) and s.st_uid==uid and s.st_nlink==1 and stat.S_IMODE(s.st_mode) in (0o600,0o644),'PAIR_PUBLICATION_TEMP_UNTRUSTED')
        finally:os.close(fd)

def reconcile(anchor,rendered,plan,generation,uid,install):
    check_plan(rendered,plan,generation)
    require(type(install) is bool,'PAIR_PUBLICATION_DIRECTION')
    preflight(anchor,rendered,generation,uid)
    changed=[]
    # Environment files first on install; drop-ins first on restore.
    # Do not reload systemd until all members and their hashes are verified.
    for p in FILES if install else reversed(FILES):
        try:fd=open_parent(anchor,p,uid,create=install)
        except RuntimeError as e:
            if not install and str(e)=='PAIR_PUBLICATION_PARENT_MISSING':continue
            raise
        try:
            fn=publish_one if install else restore_one
            if fn(fd,p.name,rendered[p],generation,uid):changed.append(str(p))
        finally:os.close(fd)
    verify_all(anchor,rendered,uid,install)
    return {'status':'PAIR_PUBLICATION_INSTALLED' if install else 'PAIR_PUBLICATION_RESTORED',
            'changed':changed,'activationEligible':False}
