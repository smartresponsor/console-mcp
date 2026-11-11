import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveMcpSiblingRepository } from '../dist/service/mcp-sibling-repository.js';
import { inspectWebDomainDefinitionLoad, registerWebDomainBridgeTools } from '../dist/tool/web-domain-bridge.js';
import { registerWebBrowserBridgeTools } from '../dist/tool/web-browser-bridge.js';
const root = mkdtempSync(join(tmpdir(), 'mcp-sibling-'));
const originalCwd = process.cwd();
try {
  mkdirSync(join(root, 'console-mcp'));
  mkdirSync(join(root, 'Browsing', 'mcp-server', 'src'), { recursive: true });
  writeFileSync(join(root, 'Browsing', 'mcp-server', 'src', 'web-domain-tool-definitions.cjs'), 'module.exports = {};');
  mkdirSync(join(root, 'Looping'));
  process.chdir(tmpdir());
  assert.equal(resolveMcpSiblingRepository('browsing', join(root, 'console-mcp')), join(root, 'Browsing'));
  assert.equal(resolveMcpSiblingRepository('looping', join(root, 'console-mcp')), join(root, 'Looping'));
  rmSync(join(root, 'Browsing'), { recursive: true });
  mkdirSync(join(root, 'Looping', 'Browsing', 'mcp-server', 'src'), { recursive: true });
  writeFileSync(join(root, 'Looping', 'Browsing', 'mcp-server', 'src', 'web-domain-tool-definitions.cjs'), 'module.exports = {};');
  assert.equal(resolveMcpSiblingRepository('browsing', join(root, 'console-mcp')), join(root, 'Looping', 'Browsing'));
  mkdirSync(join(root, 'browsing'));
  // An empty checkout must not shadow a valid nested Browsing provider.
  assert.equal(resolveMcpSiblingRepository('browsing', join(root, 'console-mcp')), join(root, 'Looping', 'Browsing'));
  mkdirSync(join(root, 'browsing', 'mcp-server', 'src'), { recursive: true });
  writeFileSync(join(root, 'browsing', 'mcp-server', 'src', 'web-domain-tool-definitions.cjs'), 'module.exports = {};');
  assert.equal(resolveMcpSiblingRepository('browsing', join(root, 'console-mcp')), join(root, 'browsing'));
  mkdirSync(join(root, '.worktrees', 'console-candidate'), { recursive: true });
  assert.equal(resolveMcpSiblingRepository('browsing', join(root, '.worktrees', 'console-candidate')), join(root, 'browsing'));
  rmSync(join(root, 'browsing'), { recursive: true });
  assert.equal(resolveMcpSiblingRepository('browsing', join(root, '.worktrees', 'console-candidate')), join(root, 'Looping', 'Browsing'));
  assert.equal(resolveMcpSiblingRepository('looping', join(root, '.worktrees', 'console-candidate')), join(root, 'Looping'));
  const tools = new Map();
  registerWebBrowserBridgeTools({ registerTool(name, schema, callback) { tools.set(name, callback); } }, { mode: 'bearer' });
  assert.ok(tools.has('read_.web.session.lease.status'), 'Canonical lease diagnostic must be exposed by actual browser bridge registration');
  const lease = (await tools.get('read_.web.session.lease.status')({
    browserSession: 'visible', targetId: 'A'.repeat(32),
  })).structuredContent;
  assert.equal(lease.status, 'LEASE_FREE');
  assert.equal(lease.observation_scope, 'local_process');
  assert.equal(lease.cross_process_visibility, false);
  const result = (await tools.get('read_.web.capability.contract')({})).structuredContent;
  assert.equal(result.status, 'WEB_CAPABILITY_CONTRACT_READY');
  assert.equal(result.contract_path, join(resolveMcpSiblingRepository('browsing'), 'mcp-server', 'src', 'capability-contract.js'));
  registerWebDomainBridgeTools({ registerTool(name, schema, callback) { tools.set(name, callback); } }, { mode: 'bearer' });
  assert.ok(tools.has('read_.web.browser.targets'));
  const definitions = inspectWebDomainDefinitionLoad();
  assert.equal(definitions.status, 'WEB_DOMAIN_DEFINITIONS_READY');
  assert.equal(definitions.definition_count, 17);
  console.log('Portable sibling resolution and real Browsing contract: PASS (arbitrary cwd).');
} finally { process.chdir(originalCwd); rmSync(root, { recursive: true, force: true }); }
