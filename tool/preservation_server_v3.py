import os,json,stat,hashlib,pathlib,socket
from preservation_identity import Hardened,serve_one
from preservation_activation import inherited
CONFIG='/etc/console-mcp/preservation-audit.json'
LOADED_MODULES=None
def bundle_identity(modules,collector):
 entries=dict(modules);entries['collector_windows.py']=collector
 return hashlib.sha256(json.dumps(entries,sort_keys=True,separators=(',',':')).encode('ascii')).hexdigest()
def bind_loaded(broker,cfg,raw):
 if LOADED_MODULES is None:raise ValueError('PRESERVATION_BUNDLE_NOT_LOADED')
 identity=bundle_identity(LOADED_MODULES,cfg['sha256'])
 if identity!=cfg['bundle_sha256'] or broker.digest!=cfg['sha256']:raise ValueError('PRESERVATION_BUNDLE_IDENTITY')
 broker.attestation={'bundleSha256':identity,'configSha256':hashlib.sha256(raw).hexdigest()}
 return broker
def trusted(path):
 p=pathlib.Path(path)
 if not p.is_absolute() or '..' in p.parts:raise ValueError('ABSOLUTE_REQUIRED')
 fd=os.open('/',os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  for part in p.parts[1:-1]:
   child=os.open(part,os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
   os.close(fd);fd=child
   st=os.fstat(fd)
   if st.st_uid!=0 or st.st_mode&0o022:raise PermissionError('UNTRUSTED_PARENT')
  with os.fdopen(os.open(p.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd),'rb') as f:
   a=os.fstat(f.fileno())
   if not stat.S_ISREG(a.st_mode) or a.st_uid!=0 or a.st_mode&0o022 or a.st_nlink!=1:raise PermissionError('UNTRUSTED_FILE')
   data=f.read(1048577)
   stamp=lambda s:(s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
   if len(data)>1048576 or len(data)!=a.st_size or stamp(a)!=stamp(os.fstat(f.fileno())) or stamp(a)!=stamp(os.stat(p.name,dir_fd=fd,follow_symlinks=False)):raise ValueError('CONFIG_CHANGED')
   return data
 finally:os.close(fd)
def unique(pairs):
 result={}
 for k,v in pairs:
  if k in result:raise ValueError('DUPLICATE_KEY')
  result[k]=v
 return result
def validate(cfg):
 import re
 if type(cfg)!=dict or set(cfg)!={'source','sha256','root','repositories','store','allowed_uids','socket','bundle_sha256'}:raise ValueError('CONFIG_SCHEMA')
 for k in ('source','root','store','socket'):
  if type(cfg[k])!=str or not os.path.isabs(cfg[k]) or os.path.normpath(cfg[k])!=cfg[k]:raise ValueError('PATH')
 if any(type(cfg[k])!=str or not re.fullmatch('[0-9a-f]{64}',cfg[k]) for k in ('sha256','bundle_sha256')):raise ValueError('DIGEST')
 u=cfg['allowed_uids']
 if type(u)!=list or len(u)!=1 or type(u[0])!=int or u[0]!=993:raise ValueError('UID')
 repos=cfg['repositories']
 if type(repos)!=dict or not repos or any(type(v)!=str for v in repos.values()) or len(set(repos.values()))!=len(repos):raise ValueError('REPOSITORIES')
 for k,v in repos.items():
  if not re.fullmatch('[A-Za-z0-9-]{1,64}',k) or type(v)!=str or not os.path.isabs(v) or os.path.realpath(v)!=v or os.path.commonpath([cfg['root'],v])!=cfg['root']:raise ValueError('REPO_PATH')
 return cfg
def main():
 if os.getuid()!=1000:raise PermissionError('ALEX_REQUIRED')
 raw=trusted(CONFIG)
 cfg=validate(json.loads(raw,object_pairs_hook=unique))
 if hashlib.sha256(trusted(cfg['source'])).hexdigest()!=cfg['sha256']:raise ValueError('SOURCE_DIGEST')
 server=inherited()
 if server.getsockname()!=cfg['socket']:raise ValueError('SOCKET_BINDING')
 b=Hardened(cfg['source'],cfg['sha256'],0,cfg['root'],cfg['repositories'],cfg['store'],set(cfg['allowed_uids']))
 try:
  bind_loaded(b,cfg,raw)
  while True:
   try:serve_one(server,b)
   except (OSError,ValueError,TimeoutError):continue
 finally:b.close();server.close()
if __name__=='__main__':main()
