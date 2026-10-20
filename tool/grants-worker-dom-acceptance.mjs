// Non-mutating, one-shot CDP acceptance. Never navigates, focuses, types, submits, or changes profiles.
import assert from 'node:assert/strict';

const ports = [9223, 9224, 9230];
const fetchJson = async (url) => {
  const response = await fetch(url, {signal: AbortSignal.timeout(4000)});
  if (!response.ok) throw Error('CDP_HTTP_' + response.status);
  return response.json();
};
const versions = await Promise.all(ports.map(p => fetchJson('http://127.0.0.1:' + p + '/json/version')));
const instances = versions.map(v => new URL(v.webSocketDebuggerUrl).pathname);
assert.equal(new Set(instances).size, 3, 'All browser instances must be distinct');

const grantTargets = await fetchJson('http://127.0.0.1:9230/json/list');
const blank = grantTargets.filter(t => t.type === 'page' && t.url === 'about:blank' && /^[0-9a-f]{32}$/i.test(t.id));
assert.equal(blank.length, 1, 'Require exactly one blank target for acceptance');
assert.equal(grantTargets.filter(t => t.type === 'page').length, 1, 'Grant worker must have no other page targets');

const connect = (rawUrl, method, params = {}) => new Promise((resolve, reject) => {
  const u = new URL(rawUrl);
  const timeout = setTimeout(() => { ws.close(); reject(Error('CDP_TIMEOUT')); }, 4500);
  if (u.protocol !== 'ws:' || u.hostname !== '127.0.0.1' || !ports.includes(Number(u.port))) {
    clearTimeout(timeout); reject(Error('CDP_ENDPOINT_OUTSIDE_LOOPBACK')); return;
  }
  const ws = new WebSocket(rawUrl);
  let completed = false;
  const end = (err, result) => {
    if (completed) return;
    completed = true;
    clearTimeout(timeout);
    try { ws.close(); } catch {}
    if (err) reject(err); else resolve(result);
  };
  ws.addEventListener('open', () => ws.send(JSON.stringify({id: 1, method, params})));
  ws.addEventListener('error', () => end(Error('CDP_SOCKET_ERROR')));
  ws.addEventListener('close', () => end(Error('CDP_SOCKET_CLOSED')));
  ws.addEventListener('message', (event) => {
    let body; try { body = JSON.parse(String(event.data)); } catch { return; }
    if (body.id !== 1) return;
    if (body.error) end(Error('CDP_METHOD_ERROR_' + body.error.code));
    else end(null, body.result);
  });
});

// The only page-level DOM request targets an existing, strictly blank grants page.
// Legacy workers receive browser-level read-only calls; no legacy page attachment.
const [legacyA, legacyB, grantDom] = await Promise.all([
  connect(versions[0].webSocketDebuggerUrl, 'Browser.getVersion'),
  connect(versions[1].webSocketDebuggerUrl, 'Browser.getVersion'),
  connect(blank[0].webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: '({isBlank: location.href === "about:blank", ready: document.readyState !== "loading"})',
    returnByValue: true, awaitPromise: false
  })
]);
assert.equal(typeof legacyA.protocolVersion, 'string');
assert.equal(typeof legacyB.protocolVersion, 'string');
assert.equal(grantDom.result?.value?.isBlank, true);
assert.equal(grantDom.result?.value?.ready, true);
const after = await Promise.all(ports.map(p => fetchJson('http://127.0.0.1:' + p + '/json/version')));
const stable = after.every((v,i) => new URL(v.webSocketDebuggerUrl).pathname === instances[i]);
assert.equal(stable, true, 'Legacy and grant instances must remain stable');
console.log(JSON.stringify({
  ok: true, status: 'GRANTS_READONLY_DOM_PARALLEL_PASS',
  legacyReadCalls: 2, grantDomReadCalls: 1,
  distinctInstances: true, stableInstances: stable,
  grantsPage: 'about:blank', grantsDomReady: true,
  mutationAttempted: false, ports
}));
