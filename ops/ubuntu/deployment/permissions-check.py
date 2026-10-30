import os,pathlib,json
assert os.getuid()==993
for name in ('/home/alex/smartresponse/mcp/console-mcp/dist/index.js','/opt/console-mcp-deploy/releases/master-e9b0554-linux-diag-zod3/dist/index.js','/opt/console-mcp-deploy/registry.json'):
 try:fd=os.open(name,os.O_WRONLY)
 except PermissionError:continue
 except OSError as e:
  assert e.errno==30;continue
 else:os.close(fd);raise RuntimeError('runtime can modify protected artifact')
status=pathlib.Path('/proc/self/status').read_text();assert 'NoNewPrivs:\t1' in status
print(json.dumps({'gate':'service-permissions','ok':True,'uid':os.getuid(),'groups':os.getgroups(),'noNewPrivileges':True,'runtimeWriteDenied':True}))
