import os,stat,hashlib,json,sys,types
NAMES=('preservation_ipc','preservation_hardened','preservation_activation','preservation_identity','preservation_server_v3')
def read_checked(d,name,owner):
 fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=d)
 with os.fdopen(fd,'rb') as f:
  a=os.fstat(f.fileno())
  if not stat.S_ISREG(a.st_mode) or a.st_uid!=owner or a.st_mode&0o022 or a.st_nlink!=1:raise PermissionError('MODULE')
  data=f.read(1048577);b=os.fstat(f.fileno())
  stamp=lambda s:(s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
  if len(data)>1048576 or len(data)!=a.st_size or stamp(a)!=stamp(b) or stamp(a)!=stamp(os.stat(name,dir_fd=d,follow_symlinks=False)):raise ValueError('MODULE_CHANGED')
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
 if set(bundle)!=set(NAMES):raise ValueError('MANIFEST')
 loaded={name+'.py':hashlib.sha256(bundle[name]).hexdigest() for name in NAMES}
 for name in NAMES:
  m=types.ModuleType(name);sys.modules[name]=m
  exec(compile(bundle[name],name+'.py','exec'),m.__dict__)
 server=sys.modules[NAMES[-1]]
 server.LOADED_MODULES=types.MappingProxyType(loaded)
 return server
def main():
 if os.getuid()!=1000:raise PermissionError('ALEX_REQUIRED')
 d=os.open('/',os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  for part in ('opt','console-mcp','preservation-audit'):
   child=os.open(part,os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=d)
   os.close(d);d=child
   st=os.fstat(d)
   if st.st_uid!=0 or st.st_mode&0o022:raise PermissionError('BUNDLE_DIRECTORY')
  def unique(pairs):
   result={}
   for k,v in pairs:
    if k in result:raise ValueError('DUPLICATE_KEY')
    result[k]=v
   return result
  manifest=json.loads(read_checked(d,'manifest.json',0),object_pairs_hook=unique)
  bundle=verify(d,manifest,0)
 finally:os.close(d)
 load(bundle).main()
if __name__=='__main__':main()
