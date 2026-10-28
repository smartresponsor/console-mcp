# Read-only staged adapter acceptance. Does not launch an MCP server or change UI state.
param([int]$ExpectedSession = 7)
$ErrorActionPreference = 'Stop'
$env:CMCP_EXPECTED_TEST_SESSION = [string]$ExpectedSession
@'
import assert from 'node:assert/strict';
import { registerWindowTools } from './dist/tool/window.js';
const handlers = new Map();
registerWindowTools({registerTool(name, config, handler) { handlers.set(name, handler); }},
  {mode:'bearer',bearerTokens:['staged-test-only']});
const call = async (name, args={}) => {
  const result = await handlers.get(name)(args);
  return JSON.parse(result.content.find(c => c.type==='text').text);
};
const inventory = await call('read_.window.inventory');
assert.equal(inventory.visibility_verified, false);
assert.equal(inventory.user_interaction_ready, false);
if (Number(process.env.CMCP_EXPECTED_TEST_SESSION) === 0) {
  assert.equal(inventory.ok, false);
  assert.equal(inventory.status, 'WINDOW_DESKTOP_UNAVAILABLE');
  console.log(JSON.stringify({status:'SESSION_ZERO_DENIED',inventory}));
} else {
  assert.equal(inventory.status, 'WINDOW_INVENTORY_READY');
  assert.ok(inventory.count > 0);
  for (const row of inventory.windows) {
    assert.equal(row.sessionId, Number(process.env.CMCP_EXPECTED_TEST_SESSION));
    assert.equal(row.sameSession, true); assert.equal(row.sameUser, true);
  }
  const edge = inventory.windows.find(w=>w.pid===29044 && w.windowId==='0x1b405a8');
  assert.ok(edge, 'Exact existing Edge HWND is required for this acceptance');
  const inspected = await call('read_.window.inspect',{windowId:edge.windowId});
  assert.equal(inspected.status,'WINDOW_INSPECTED');
  assert.equal(inspected.window.pid,edge.pid);
  assert.equal(inspected.window.processStartedAt,edge.processStartedAt);
  const focus = await call('read_.window.inspect.focus');
  assert.equal(focus.status,'WINDOW_FOCUS_INSPECTED');
  const missing = await call('read_.window.inspect',{windowId:'0x0'});
  assert.equal(missing.status,'WINDOW_NOT_LISTED');
  const activation = await call('write.window.activate',{windowId:edge.windowId,approved:true});
  assert.equal(activation.status,'WINDOW_ACTIVATION_UNSUPPORTED');
  console.log(JSON.stringify({status:'WINDOWS_HWND_ADAPTER_GREEN',count:inventory.count,
    edge,inspected,focus,missing,activation,staged:true,productionWorkerReplaced:false}));
}
'@ | node --input-type=module -
exit $LASTEXITCODE
