import hashlib,os,subprocess,time
def capture(path):
    deadline=time.monotonic()+30
    env={'PATH':'/usr/bin:/bin','HOME':os.environ['HOME'],'GIT_OPTIONAL_LOCKS':'0','GIT_TERMINAL_PROMPT':'0','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':os.devnull,'GIT_NO_LAZY_FETCH':'1'}
    def git(args,limit=16*1024*1024):
        # Bounded stdout on disk, not an unbounded PIPE allocation.
        import tempfile,resource
        with tempfile.TemporaryFile() as f:
            def limits():resource.setrlimit(resource.RLIMIT_FSIZE,(limit,limit))
            remaining=deadline-time.monotonic()
            if remaining<=0:raise TimeoutError('BASELINE_TIMEOUT')
            r=subprocess.run(['/usr/bin/git','-C',path,'-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',*args],stdout=f,stderr=subprocess.DEVNULL,env=env,timeout=remaining,preexec_fn=limits)
            if r.returncode:raise ValueError('BASELINE_GIT')
            f.seek(0);return f.read(limit+1).decode('utf8','replace')
    # Candidate only: never silently run repository-configured filters as owner.
    config=git(['config','--local','--no-includes','--list'])
    if any(line.lower().startswith(('filter.','include.','includeif.','diff.','core.fsmonitor=')) for line in config.splitlines()):raise ValueError('BASELINE_UNSAFE_CONFIG')
    if os.path.realpath(git(['rev-parse','--show-toplevel']).strip())!=os.path.realpath(path):raise ValueError('BASELINE_ROOT')
    head=git(['rev-parse','HEAD']).strip()
    status=git(['status','--porcelain=v1','-z'])
    diff=git(['diff','--no-ext-diff','--no-textconv','--binary','HEAD','--','.'])
    files=sorted(filter(None,git(['ls-files','--others','--exclude-standard','-z'],4*1024*1024).split('\0')),key=lambda x:x.encode('utf-16-be','surrogatepass'))
    if len(files)>200:raise ValueError('BASELINE_LIMIT')
    hashes=[]
    import re
    for name in files:
        if not os.path.isfile(os.path.join(path,name)) or os.path.islink(os.path.join(path,name)):raise ValueError('BASELINE_FILE')
        if os.path.commonpath([os.path.realpath(path),os.path.realpath(os.path.join(path,name))])!=os.path.realpath(path):raise ValueError('BASELINE_FILE')
        h=git(['hash-object','--no-filters','--',name],1024*1024).strip()
        if not re.fullmatch('[a-f0-9]{40}',h):raise ValueError('BASELINE_HASH')
        hashes.append(name+'\0'+h)
    if not re.fullmatch('[a-f0-9]{40}',head):raise ValueError('BASELINE_HEAD')
    sha=lambda x:hashlib.sha256(x.encode('utf8')).hexdigest()
    return dict(head=head,statusHash=sha(status),worktreeFingerprint=sha(status+'\n--DIFF--\n'+diff+'\n--UNTRACKED--\n'+'\n'.join(hashes)))
