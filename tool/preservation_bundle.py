import os,stat,hashlib,json,sys,types
NAMES=('preservation_ipc','preservation_hardened','preservation_activation','preservation_identity','preservation_server_v3')
def read_checked(d,name,owner):
 fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=d)
 with os.fdopen(fd,'rb') as f:
  a=os.fstat(f.fileno())
  if not stat.S_ISREG(a.st_mode) or a.st_uid!=owner or a.st_mode&0o022 or a.st_nlink!=1:raise PermissionError('MODULE')
  data=f.read(1048577);b=os.fstat(f.fileno())
  if len(data)>1048576 or (a.st_size,a.st_mtime_ns,a.st_ctime_ns)!=(b.st_size,b.st_mtime_ns,b.st_ctime_ns):raise ValueError('MODULE_CHANGED')
  return data
def verify(d,manifest,owner):
 if set(manifest)!=set(NAMES):raise ValueError('MANIFEST')
 result={}
 for name in NAMES:
  data=read_checked(d,name+'.py',owner)
  if hashlib.sha256(data).hexdigest()!=manifest[name]:raise ValueError('MODULE_DIGEST')
  result[name]=data
 return result
def load(bundle):
 for name in NAMES:
  m=types.ModuleType(name);sys.modules[name]=m
  exec(compile(bundle[name],name+'.py','exec'),m.__dict__)
 return sys.modules[NAMES[-1]]
def main():
 if os.getuid()!=1000:raise PermissionError('ALEX_REQUIRED')
 d=os.open('/opt/console-mcp/preservation-audit',os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  st=os.fstat(d)
  if st.st_uid!=0 or st.st_mode&0o022:raise PermissionError('BUNDLE_DIRECTORY')
  manifest=json.loads(read_checked(d,'manifest.json',0))
  bundle=verify(d,manifest,0)
 finally:os.close(d)
 load(bundle).main()
if __name__=='__main__':main()
