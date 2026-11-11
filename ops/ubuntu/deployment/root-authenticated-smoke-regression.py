#!/usr/bin/python3
"""Fixture-only test for privileged MCP health/tool discovery. No live credentials or browser."""
import json
from pathlib import Path
import runpy
import urllib.request
from unittest.mock import patch

gates=runpy.run_path(str(Path(__file__).with_name("gates.py")),run_name="fixture_library")
smoke=gates["authenticated_candidate_smoke"]
glob=smoke.__globals__
pid=321
fingerprint="verified-build-fixture"
required=["read_.system.console.health","read_.system.console.describe","read_.repo.workspace.status"]
calls=[]
def mock_rpc(p, port, name, args=None):
 assert p==pid and port==3334
 calls.append(name)
 if name is None:return required+["read_.web.browser.status"]
 return {"ok":True,"pid":pid,"buildFingerprint":fingerprint,"canonicalRegistryFingerprint":"fixture"}
old_rpc=glob["rpc"]
glob["rpc"]=mock_rpc
try:
 health,count=smoke(pid,3334,fingerprint)
 assert health["pid"]==pid and count==4
 assert calls==["read_.system.console.health",None]
 for bad in ([],required[:2],["read_.system.console.health"]*3):
  glob["rpc"]=lambda p,port,name,args=None,bad=bad: bad if name is None else {"ok":True,"pid":pid,"buildFingerprint":fingerprint}
  try:smoke(pid,3334,fingerprint)
  except RuntimeError:pass
  else:raise AssertionError("incomplete or ambiguous catalog accepted")
 glob["rpc"]=lambda p,port,name,args=None: required if name is None else {"ok":True,"pid":pid,"buildFingerprint":"WRONG"}
 try:smoke(pid,3334,fingerprint)
 except RuntimeError:pass
 else:raise AssertionError("wrong build fingerprint accepted")
finally:glob["rpc"]=old_rpc

class Reply:
 def __init__(self, data, headers=None):self.data=json.dumps(data).encode();self.headers=headers or {}
 def __enter__(self):return self
 def __exit__(self,*a):return False
 def read(self,n=-1):return self.data[:n]
 def readline(self,n=-1):return self.data[:n]
class Opener:
 def __init__(self,next_cursor=False):self.requests=[];self.next_cursor=next_cursor
 def open(self,request,timeout):
  self.requests.append(request)
  payload=json.loads(request.data)
  method=payload["method"]
  if method=="initialize":return Reply({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05"}},{"Mcp-Session-Id":"fixture-session"})
  if method=="notifications/initialized":return Reply({})
  if method=="tools/list":
   listing={"tools":[{"name":n} for n in required]}
   if self.next_cursor:listing["nextCursor"]="more"
   return Reply({"jsonrpc":"2.0","id":2,"result":listing})
  raise AssertionError("unexpected MCP method")
for cursor in (False,True):
 opener=Opener(cursor)
 with patch.dict(gates["rpc"].__globals__,{"env":lambda p:{"CONSOLE_MCP_BEARER_TOKEN":"fixture-secret-not-real"}}):
  with patch.object(urllib.request,"build_opener",return_value=opener):
   try:listed=gates["rpc"](pid,3334,None)
   except RuntimeError:
    assert cursor, "valid catalog rejected"
   else:
    assert not cursor and listed==required
 assert len(opener.requests)==3
 assert all(req.get_header("Authorization")=="Bearer fixture-secret-not-real" for req in opener.requests)
 assert all(req.full_url=="http://127.0.0.1:3334/mcp" for req in opener.requests)
 assert all(b"fixture-secret-not-real" not in req.data for req in opener.requests)
verify_receipt=gates["VERIFY_SANDBOX_AUTH"]
baseline={"passed":True,"authenticatedMcpSmoke":True,"sourceSHA":"candidate-sha","candidate":"candidate-sha","registryFingerprint":"reg-fp","checkpoint":"generation-A","buildFingerprint":"sealed-build","advertisedToolCount":317,"pid":1234,"at":1000.0}
params={"role":"candidate","release_sha":"candidate-sha","release_id":"candidate-sha","checkpoint":"generation-A","registry_fingerprint":"reg-fp","expected_build":"sealed-build","now":1001.0}
assert verify_receipt(baseline,**params) is True
for field,bad in (("passed",False),("authenticatedMcpSmoke",False),("sourceSHA","other"),("candidate","other"),("checkpoint","generation-B"),("registryFingerprint","other"),("buildFingerprint","other"),("advertisedToolCount",0),("advertisedToolCount",True),("pid",0),("at",0),("at",2000)):
 altered=dict(baseline);altered[field]=bad
 try:verify_receipt(altered,**params)
 except RuntimeError:pass
 else:raise AssertionError(f"Tampered receipt accepted: {field}={bad}")
for stale_time in (1600.0,999.0):
 try:verify_receipt(baseline,**{**params,"now":stale_time})
 except RuntimeError:pass
 else:raise AssertionError("Out-of-window receipt accepted")
rollback={**baseline,"rollback":"old-release"}
rollback.pop("candidate")
rollback_params={**params,"role":"rollback","release_id":"old-release"}
assert verify_receipt(rollback,**rollback_params) is True
for changed in ({"sourceSHA":"different-candidate"},{"rollback":"another-rollback"},{"checkpoint":"generation-B"},{"registryFingerprint":"previous-registry"}):
 altered={**rollback,**changed}
 try:verify_receipt(altered,**rollback_params)
 except RuntimeError:pass
 else:raise AssertionError(f"Stale rollback receipt accepted: {changed}")

for role_proof,role_args in ((baseline,params),(rollback,rollback_params)):
 try:verify_receipt(role_proof,**{**role_args,"checkpoint":"generation-B"})
 except RuntimeError:pass
 else:raise AssertionError("Cross-generation authenticated receipt replay accepted")

print(json.dumps({"status":"ROOT_AUTHENTICATED_MCP_SMOKE_FIXTURE_GREEN","rootRequired":True,"fixtureOnly":True,"validatedToolCatalog":True,"cursorFailsClosed":True,"receiptReplayBlocked":True,"bearerInHeaderOnly":True,"secretRead":False,"liveMcpContact":False}))
