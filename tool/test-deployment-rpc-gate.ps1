$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
@'
import ast, pathlib, sys, unittest, json, io, signal, time
from unittest.mock import patch
import urllib.request
source=pathlib.Path(sys.argv[1]).read_text()
tree=ast.parse(source)
ns=dict(urllib=urllib, json=json, sys=sys, time=time, env=lambda pid: {'CONSOLE_MCP_BEARER_TOKEN':'test-only'})
exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name in ('rpc','NoRedirect')],type_ignores=[]),'<gate>','exec'),ns)
class Response(io.BytesIO):
 def __init__(self,data=b'',kind='application/json',status=200):
  super().__init__(data);self.headers={'Content-Type':kind};self.status=status
class Tests(unittest.TestCase):
 def call(self,response):
  hello=Response(b'{"id":1,"result":{"protocolVersion":"2024-11-05"}}')
  with patch('urllib.request.build_opener') as factory:
   factory.return_value.open.side_effect=[hello,Response(status=202),response]
   return ns['rpc'](1,1234,'read_.system.console.health')
 def test_json(self):
  self.assertEqual(self.call(Response(b'{"id":2,"result":{"content":[{"text":"{\\"ok\\":true}"}]}}')),{'ok':True})
 def test_sse_multiline(self):
  data=b': heartbeat\r\n\r\ndata: {"id":99}\r\n\r\ndata: {"id":2,\r\ndata: "result":{"content":[{"text":"{\\"ok\\":true}"}]}}\r\n\r\n'
  self.assertEqual(self.call(Response(data,'text/event-stream')),{'ok':True})
 def test_wrong_id(self):
  with self.assertRaises(RuntimeError):self.call(Response(b'{"id":3}'))
 def test_truncated(self):
  with self.assertRaises(RuntimeError):self.call(Response(b'data: {"id":2}\n','text/event-stream'))
 def test_limit(self):
  with self.assertRaises(RuntimeError):self.call(Response(b'x'*1048577,'text/event-stream'))
 def test_deadline(self):
  class Stall(Response):
   def readline(self,*args):
    signal.raise_signal(signal.SIGALRM)
  previous=signal.getsignal(signal.SIGALRM)
  with self.assertRaises(RuntimeError):self.call(Stall(kind='text/event-stream'))
  self.assertEqual(signal.getsignal(signal.SIGALRM),previous)
  self.assertEqual(signal.getitimer(signal.ITIMER_REAL),(0.,0.))
unittest.main(argv=['gate-tests'],verbosity=2)
'@ | & /usr/bin/python3 -I - (Join-Path $root 'ops/ubuntu/deployment/gates.py')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
