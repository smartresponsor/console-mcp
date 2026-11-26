import unittest,tempfile,pathlib,subprocess,hashlib
from preservation_baseline import capture
class Test(unittest.TestCase):
 def test_fresh(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)
   def git(*a):return subprocess.check_output(['git','-C',d,*a])
   git('init','-q');git('config','user.email','dev@smartresponsor.com');git('config','user.name','Fixture');git('config','core.autocrlf','false');(p/'a').write_text('base');git('add','a');git('-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-qm','base')
   (p/'a').write_text('changed');(p/'b').write_text('new')
   index=(p/'.git/index').read_bytes()
   a=capture(d)
   status=git('status','--porcelain=v1','-z');diff=git('diff','--binary','HEAD','--','.');h=git('hash-object','--no-filters','--','b').strip()
   self.assertEqual(a['worktreeFingerprint'],hashlib.sha256(status+b'\n--DIFF--\n'+diff+b'\n--UNTRACKED--\nb\0'+h).hexdigest())
   self.assertEqual(a,capture(d));(p/'b').write_text('newer');self.assertNotEqual(a,capture(d))
   git('config','filter.example.clean','false')
   with self.assertRaisesRegex(ValueError,'BASELINE_UNSAFE_CONFIG'):capture(d)
 def test_active_broker(self):
  from preservation_identity import Hardened
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)
   repo=p/'repo';repo.mkdir()
   store=p/'store';store.mkdir(mode=0o700)
   def git(*a):return subprocess.check_output(['git','-C',str(repo),*a])
   git('init','-q');git('config','user.email','fixture@example.com');git('config','user.name','Fixture')
   (repo/'a').write_text('base\n');git('add','a');git('-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-qm','base')
   broker=Hardened('', '0'*64, 0,d,{'fixture':str(repo)},str(store),{__import__('os').getuid()})
   try:
    r={'repository':'fixture','requestId':'fixture','operation':'baseline'}
    def baseline():return broker.baseline(r,broker.identity(r))['baseline']
    first=baseline()
    self.assertEqual(first['fingerprintVersion'],'preservation-v3')
    self.assertEqual(first,baseline())
    (repo/'a').write_text('changed \n');git('add','a')
    self.assertFalse(baseline()['diffCheckOk'])
    self.assertNotEqual(first['worktreeFingerprint'],baseline()['worktreeFingerprint'])
    import os
    untracked=repo/'untracked'
    untracked.write_bytes(b'first')
    original=baseline()
    untracked.write_bytes(b'other')
    self.assertNotEqual(original['worktreeFingerprint'],baseline()['worktreeFingerprint'])
    untracked.unlink()
    os.link(repo/'a',untracked)
    with self.assertRaisesRegex(ValueError,'BASELINE_FILE_POLICY'):baseline()
    untracked.unlink()
    untracked.symlink_to(repo/'a')
    with self.assertRaisesRegex(ValueError,'BASELINE_FILE_POLICY'):baseline()
    untracked.unlink()
    git('config','filter.example.clean','false')
    with self.assertRaisesRegex(ValueError,'BASELINE_CONFIG_POLICY'):baseline()
   finally:broker.close()
 def test_configuration_aba_isolation(self):
  import os
  from unittest.mock import patch
  import preservation_identity as module
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);repo=root/'repo';repo.mkdir()
   store=root/'store';store.mkdir(mode=0o700)
   def git(*a):return subprocess.check_output(['git','-C',str(repo),*a])
   git('init','-q');git('config','user.email','fixture@example.com');git('config','user.name','Fixture')
   (repo/'a').write_text('base\n');(repo/'.gitattributes').write_text('a filter=attack\n')
   git('add','.');git('-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-qm','base')
   (repo/'a').write_text('changed\n')
   broker=module.Hardened('','0'*64,0,d,{'fixture':str(repo)},str(store),{os.getuid()})
   try:
    r={'repository':'fixture','requestId':'fixture','operation':'baseline'}
    config=repo/'.git/config';original=config.read_bytes();marker=root/'filter-executed'
    poisoned=original+b'\n[filter "attack"]\n\tclean = touch '+os.fsencode(marker)+b'; cat\n\trequired = true\n'
    identity=broker.identity(r);expected=broker.baseline(r,identity)['baseline']
    projection=module.isolated_git_config;resolve=broker.identity
    def inject(i,shadow,env):
     projection(i,shadow,env)
     config.write_bytes(poisoned)
    def restore_and_resolve(request):
     config.write_bytes(original)
     return resolve(request)
    # Simulate an ABA replacement: the hostile config is present during Git
    # commands and restored immediately before each identity check.
    with patch.object(module,'isolated_git_config',side_effect=inject),patch.object(broker,'identity',side_effect=restore_and_resolve):
     self.assertEqual(expected,broker.baseline(r,identity)['baseline'])
    self.assertFalse(marker.exists())
    # A persistent mutation must be rejected, also without invoking the filter.
    with patch.object(module,'isolated_git_config',side_effect=inject):
     with self.assertRaisesRegex(ValueError,'IDENTITY_CHANGED'):broker.baseline(r,identity)
    self.assertFalse(marker.exists())
   finally:
    config.write_bytes(original)
    broker.close()
 def test_linked_worktree_projection(self):
  import os
  from preservation_identity import Hardened
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);repo=root/'repo';repo.mkdir()
   linked=root/'linked';store=root/'store';store.mkdir(mode=0o700)
   def git(*a):return subprocess.check_output(['git','-C',str(repo),*a])
   git('init','-q');git('config','user.email','fixture@example.com');git('config','user.name','Fixture')
   (repo/'a').write_text('base\n');git('add','a');git('-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-qm','base')
   git('worktree','add','-qb','fixture-linked',str(linked))
   broker=Hardened('','0'*64,0,d,{'fixture':str(linked)},str(store),{os.getuid()})
   try:
    r={'repository':'fixture','requestId':'fixture','operation':'baseline'}
    identity=broker.identity(r)
    self.assertNotEqual(identity['gitdir'],identity['common'])
    first=broker.baseline(r,identity)['baseline']
    self.assertEqual(first['head'],git('rev-parse','HEAD').decode().strip())
    (linked/'a').write_text('changed\n')
    self.assertNotEqual(first['worktreeFingerprint'],broker.baseline(r,identity)['baseline']['worktreeFingerprint'])
    backref=pathlib.Path(identity['gitdir'])/'gitdir';original=backref.read_bytes()
    try:
     backref.write_bytes(os.fsencode(repo/'.git')+b'\n')
     with self.assertRaisesRegex(ValueError,'GIT_ROOT'):broker.identity(r)
    finally:backref.write_bytes(original)
   finally:broker.close()
 def test_isolated_collector_report(self):
  import os,json
  from preservation_identity import Hardened
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);repo=root/'repo';repo.mkdir()
   linked=root/'linked';store=root/'store';store.mkdir(mode=0o700)
   def git(*a):return subprocess.check_output(['git','-C',str(repo),*a])
   git('init','-q');git('config','user.email','fixture@example.com');git('config','user.name','Fixture')
   (repo/'a').write_text('base\n');git('add','a');git('-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-qm','base')
   git('worktree','add','-qb','fixture-linked',str(linked))
   (linked/'a').write_text('changed\n')
   (linked/'.gitattributes').write_text('a filter=attack\n')
   source=root/'verified-collector.py'
   source.write_bytes(pathlib.Path(__file__).with_name('collector_windows.py').read_bytes())
   source.chmod(0o400)
   digest=hashlib.sha256(source.read_bytes()).hexdigest()
   broker=Hardened(source,digest,source.stat().st_uid,d,{'fixture':str(linked)},str(store),{os.getuid()})
   try:
    r={'repository':'fixture','requestId':'collector-one','operation':'preserve'}
    reply=broker.handle_request(r)
    raw=(store/'collector-one.jsonl').read_bytes();lines=raw.splitlines(keepends=True)
    rows=[json.loads(line) for line in lines]
    self.assertEqual(reply['status'],'COMPLETE',str([x for x in rows if x['type']=='error']))
    self.assertEqual(reply['sha256'],hashlib.sha256(raw).hexdigest())
    self.assertEqual({x['path'] for x in rows if x['type']=='worktree_state'},{str(repo),str(linked)})
    self.assertEqual(rows[-1]['body_sha256'],hashlib.sha256(b''.join(lines[:-1])).hexdigest())
    self.assertEqual(reply,broker.handle_request(r))
    self.assertTrue(any(x['type']=='patch_id' for x in rows))
    from unittest.mock import patch
    import preservation_identity as module
    config=repo/'.git/config';original=config.read_bytes()
    marker=root/'collector-filter-executed'
    poisoned=original+b'\n[filter "attack"]\n\tclean = touch '+os.fsencode(marker)+b'; cat\n\trequired = true\n'
    invoke=subprocess.run
    def inject(argv,*args,**kwargs):
     if any(isinstance(x,str) and x.startswith('--git-dir=') for x in argv):
      config.write_bytes(poisoned)
      try:return invoke(argv,*args,**kwargs)
      finally:config.write_bytes(original)
     return invoke(argv,*args,**kwargs)
    try:
     with patch.object(module.subprocess,'run',side_effect=inject):
      second=broker.handle_request(dict(r,requestId='collector-aba'))
     self.assertEqual(second['status'],'COMPLETE')
     self.assertFalse(marker.exists())
     second_rows=[json.loads(x) for x in (store/'collector-aba.jsonl').read_bytes().splitlines()]
     self.assertEqual([x for x in rows if x['type']=='worktree_state'],[x for x in second_rows if x['type']=='worktree_state'])
     config.write_bytes(poisoned)
     rejected=broker.handle_request(dict(r,requestId='collector-invalid-config'))
     self.assertEqual(rejected['status'],'PARTIAL')
     self.assertFalse(marker.exists())
    finally:config.write_bytes(original)
   finally:broker.close()
 def test_collector_timeout_crash_and_lock_recovery(self):
  import os,time,signal
  from unittest.mock import patch
  from preservation_identity import Hardened,CollectorGit
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);repo=root/'repo';repo.mkdir()
   store=root/'store';store.mkdir(mode=0o700)
   def git(*a):return subprocess.check_output(['git','-C',str(repo),*a])
   git('init','-q');git('config','user.email','fixture@example.com');git('config','user.name','Fixture')
   (repo/'a').write_text('base\n');git('add','a');git('-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-qm','base')
   source=root/'verified-collector.py';source.write_bytes(pathlib.Path(__file__).with_name('collector_windows.py').read_bytes());source.chmod(0o400)
   digest=hashlib.sha256(source.read_bytes()).hexdigest()
   broker=Hardened(source,digest,os.getuid(),d,{'fixture':str(repo)},str(store),{os.getuid()},timeout=2)
   marker=root/'collector-started'
   r={'repository':'fixture','requestId':'timeout-fixture','operation':'preserve'}
   def stall(*args,**kwargs):
    marker.write_text(str(os.getpid()))
    time.sleep(60)
    raise AssertionError('deadline failed')
   def scratch():return [p for p in store.iterdir() if p.name.startswith(('.pending-','.projection-'))]
   try:
    with patch.object(CollectorGit,'__call__',stall):
     with self.assertRaisesRegex(TimeoutError,'TIMEOUT'):broker.handle_request(r)
    self.assertTrue(marker.exists())
    self.assertFalse(scratch())
    self.assertFalse((store/'timeout-fixture.jsonl').exists())
    marker.unlink()
    with patch.object(CollectorGit,'__call__',stall):
     parent=os.fork()
     if parent==0:
      try:broker.handle_request(dict(r,requestId='crash-fixture'))
      finally:os._exit(97)
     reaped=False
     try:
      until=time.monotonic()+1.5
      while not marker.exists() and time.monotonic()<until:time.sleep(.02)
      self.assertTrue(marker.exists())
      probe=dict(r,requestId='probe',operation='baseline')
      self.assertEqual(broker.handle_request(probe)['status'],'BUSY')
      os.kill(parent,signal.SIGKILL);os.waitpid(parent,0);reaped=True
      self.assertEqual(broker.handle_request(probe)['status'],'BUSY')
      self.assertTrue(scratch())
      until=time.monotonic()+5
      while time.monotonic()<until:
       result=broker.handle_request(probe)
       if result['status']!='BUSY':break
       time.sleep(.05)
      self.assertEqual(result['status'],'BASELINE_COMPLETE')
      self.assertFalse(scratch())
      self.assertFalse((store/'crash-fixture.jsonl').exists())
     finally:
      if not reaped:
       try:os.kill(parent,signal.SIGKILL)
       except ProcessLookupError:pass
       os.waitpid(parent,0)
    broker.timeout=10
    self.assertEqual(broker.handle_request(dict(r,requestId='after-crash'))['status'],'COMPLETE')
    self.assertFalse(scratch())
   finally:broker.close()
 def test_shared_metadata_snapshot(self):
  import os
  from preservation_identity import Hardened,isolated_git_config
  from unittest.mock import patch
  import preservation_identity as module
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);repo=root/'repo';repo.mkdir()
   store=root/'store';store.mkdir(mode=0o700)
   def git(*a):return subprocess.check_output(['git','-C',str(repo),*a])
   git('init','-q');git('config','user.email','fixture@example.com');git('config','user.name','Fixture')
   (repo/'a').write_text('base\n');git('add','a');git('-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-qm','base')
   git('repack','-ad')
   broker=Hardened('','0'*64,0,d,{'fixture':str(repo)},str(store),{os.getuid()})
   r={'repository':'fixture','requestId':'fixture','operation':'baseline'}
   objects=repo/'.git/objects';refs=repo/'.git/refs'
   try:
    def baseline():return broker.baseline(r,broker.identity(r))['baseline']
    expected=baseline()
    alternate=objects/'info/alternates';alternate.write_text(str(root/'external')+'\n')
    with self.assertRaisesRegex(ValueError,'SHARED_METADATA_POLICY'):baseline()
    alternate.unlink()
    external=root/'external';external.mkdir()
    link=refs/'external';link.symlink_to(external,target_is_directory=True)
    with self.assertRaisesRegex(ValueError,'SHARED_METADATA_POLICY'):baseline()
    link.unlink()
    pack=next((objects/'pack').glob('*.pack'))
    promisor=pack.with_suffix('.promisor');promisor.touch()
    with self.assertRaisesRegex(ValueError,'SHARED_METADATA_POLICY'):baseline()
    promisor.unlink()
    def inject(identity,shadow,env):
     isolated_git_config(identity,shadow,env)
     for name in ('objects','refs'):
      self.assertFalse((pathlib.Path(shadow)/name).is_symlink())
     # Original objects are unavailable during the real Git commands.
     objects.rename(root/'held-objects')
     objects.symlink_to(external,target_is_directory=True)
    original=broker.identity
    def restore(request):
     if objects.is_symlink():
      objects.unlink();(root/'held-objects').rename(objects)
     return original(request)
    try:
     identity=broker.identity(r)
     with patch.object(module,'isolated_git_config',side_effect=inject),patch.object(broker,'identity',side_effect=restore):
      self.assertEqual(expected,broker.baseline(r,identity)['baseline'])
    finally:restore(r)
   finally:broker.close()
 def test_peer_credentials_negative(self):
  import os,socket
  from preservation_ipc import request,client,peer
  left,right=socket.socketpair(socket.AF_UNIX,socket.SOCK_STREAM)
  with left,right:
   # Use a connected pair with kernel-reported credentials, not a mocked UID.
   self.assertEqual(peer(left),os.getuid())
   with self.assertRaisesRegex(PermissionError,'PEER_DENIED'):
    request(left,{os.getuid()+1})
   with self.assertRaisesRegex(PermissionError,'SERVER_DENIED'):
    client(left,os.getuid()+1,{'requestId':'fixture'})
if __name__=='__main__':unittest.main()
