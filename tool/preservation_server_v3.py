import os,json,stat,hashlib,pathlib,socket
from preservation_identity import Hardened,serve_one
from preservation_activation import inherited
CONFIG='/etc/console-mcp/preservation-audit.json'
def trusted(path):
 p=pathlib.Path(path)
 if not p.is_absolute():raise ValueError('ABSOLUTE_REQUIRED')
 for parent in reversed(p.parents):
  st=parent.lstat()
  if not stat.S_ISDIR(st.st_mode) or st.st_uid!=0 or st.st_mode&0o022:raise PermissionError('UNTRUSTED_PARENT')
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 with os.fdopen(fd,'rb') as f:
  st=os.fstat(f.fileno())
  if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_mode&0o022 or st.st_nlink!=1:raise PermissionError('UNTRUSTED_FILE')
  data=f.read(1048577)
  if len(data)>1048576:raise ValueError('SIZE')
  return data
def unique(pairs):
 result={}
 for k,v in pairs:
  if k in result:raise ValueError('DUPLICATE_KEY')
  result[k]=v
 return result
def validate(cfg):
 import re
 if type(cfg)!=dict or set(cfg)!={'source','sha256','root','repositories','store','allowed_uids','socket'}:raise ValueError('CONFIG_SCHEMA')
 for k in ('source','root','store','socket'):
  if type(cfg[k])!=str or not os.path.isabs(cfg[k]) or os.path.normpath(cfg[k])!=cfg[k]:raise ValueError('PATH')
 if type(cfg['sha256'])!=str or not re.fullmatch('[0-9a-f]{64}',cfg['sha256']):raise ValueError('DIGEST')
 u=cfg['allowed_uids']
 if type(u)!=list or not u or any(type(x)!=int or x not in (993,1000) for x in u) or len(set(u))!=len(u):raise ValueError('UID')
 repos=cfg['repositories']
 if type(repos)!=dict or not repos:raise ValueError('REPOSITORIES')
 for k,v in repos.items():
  if not re.fullmatch('[A-Za-z0-9-]{1,64}',k) or type(v)!=str or not os.path.isabs(v) or os.path.realpath(v)!=v or os.path.commonpath([cfg['root'],v])!=cfg['root']:raise ValueError('REPO_PATH')
 return cfg
def main():
 if os.getuid()!=1000:raise PermissionError('ALEX_REQUIRED')
 cfg=validate(json.loads(trusted(CONFIG),object_pairs_hook=unique))
 if set(cfg)!={'source','sha256','root','repositories','store','allowed_uids','socket'}:raise ValueError('CONFIG_SCHEMA')
 if hashlib.sha256(trusted(cfg['source'])).hexdigest()!=cfg['sha256']:raise ValueError('SOURCE_DIGEST')
 server=inherited()
 if server.getsockname()!=cfg['socket']:raise ValueError('SOCKET_BINDING')
 b=Hardened(cfg['source'],cfg['sha256'],0,cfg['root'],cfg['repositories'],cfg['store'],set(cfg['allowed_uids']))
 try:
  while True:
   try:serve_one(server,b)
   except (OSError,ValueError,TimeoutError):continue
 finally:b.close();server.close()
if __name__=='__main__':main()
