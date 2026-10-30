import os,pathlib,json,pwd
assert os.getuid()==pwd.getpwnam('console-mcp').pw_uid
base=pathlib.Path('/opt/console-mcp-deploy')
registry=json.loads((base/'registry.json').read_text())
role=os.environ.get('CONSOLE_MCP_DEPLOY_ROLE','candidate')
assert role in ('candidate','rollback')
name=registry[role]
assert pathlib.Path(name).name==name and name not in ('.','..')
for name in ('/home/alex/smartresponse/mcp/console-mcp/dist/index.js',str(base/'releases'/name/'dist/index.js'),str(base/'registry.json')):
 try:fd=os.open(name,os.O_WRONLY)
 except PermissionError:continue
 except OSError as e:
  assert e.errno==30;continue
 else:os.close(fd);raise RuntimeError('runtime can modify protected artifact')
status=pathlib.Path('/proc/self/status').read_text();assert 'NoNewPrivs:\t1' in status
print(json.dumps({'gate':'service-permissions','ok':True,'uid':os.getuid(),'groups':os.getgroups(),'noNewPrivileges':True,'runtimeWriteDenied':True}))
