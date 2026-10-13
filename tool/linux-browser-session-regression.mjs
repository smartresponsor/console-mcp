import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { registerBrowserSessionTool } from '../dist/tool/browser-session.js';
assert.equal(process.platform, 'linux', 'This explicit platform regression requires Linux.');
const server = createServer((req, res) => {
  if (req.url === '/redirect') { res.writeHead(302, { location: 'http://example.invalid/private' }); }
  res.end('fixture healthy');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
let handler;
registerBrowserSessionTool({ registerTool(_name, _config, h) { handler = h; } }, { mode: 'bearer', bearerTokens: ['fixture'] });
try {
  const port = server.address().port;
  const parse = result => JSON.parse(result.content[0].text);
  const result = parse(await handler({ ports: [port], healthUrls: [`http://127.0.0.1:${port}`], includeRawDetails: true, timeoutMs: 1000 }));
  assert.equal(result.platform, 'linux');
  assert.equal(result.listeners.open_count, 1);
  assert.equal(result.health.ok_count, 1);
  assert.equal(result.diagnostic.windows_apis_used, false);
  assert.equal(result.browser.visibility_supported, false);
  assert.equal(result.browser.visible_window_count, null, 'Process presence must not falsely prove a visible window.');
  assert.ok(result.details.browser_processes.every(p => !('command_line' in p)), 'Diagnostics must not leak process arguments.');
  await assert.rejects(handler({ healthUrls: ['https://example.invalid'] }), /loopback/);
  await assert.rejects(handler({ healthUrls: ['http://user:secret@127.0.0.1'] }), /Credentials/);
  const redirected = parse(await handler({ includeBrowserProcesses: false, includeListeners: false, healthUrls: [`http://127.0.0.1:${port}/redirect`], timeoutMs: 1000 }));
  assert.equal(redirected.health.ok_count, 0, 'Loopback health requests must not follow redirects off-host.');
  console.log('Linux browser diagnostic regression PASS: TCP/HTTP, honest visibility, secret-free details, URL and redirect boundaries.');
} finally {
  server.close();
  await once(server, 'close');
}
