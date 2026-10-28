import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { resolveMcpSiblingRepository } from '../dist/service/mcp-sibling-repository.js';
import { registerWebDomainBridgeTools, inspectWebDomainDefinitionLoad, consoleWebDomainToolNames } from '../dist/tool/web-domain-bridge.js';
import { runWithMcpRequestContext } from '../dist/Infrastructure/Diagnostics/RequestContext.js';
import { classifyWebConsumerOutcome } from '../dist/Consumer/Web/WebOutcomePolicy.js';

const loaded = inspectWebDomainDefinitionLoad();
assert.equal(loaded.status, 'WEB_DOMAIN_DEFINITIONS_READY', JSON.stringify(loaded));
assert.equal(loaded.definition_count, consoleWebDomainToolNames.length);
const definitions = createRequire(import.meta.url)(`${resolveMcpSiblingRepository('browsing')}/mcp-server/src/web-domain-tool-definitions.cjs`).createWebCoreDomainToolDefinitions();
assert.deepEqual(new Set(definitions.map(d => d.consoleName)), new Set(consoleWebDomainToolNames));
for (const d of definitions) {
  assert.match(d.canonicalName, /^web\./);
  assert.match(d.capabilityName, /^web\./);
  assert.ok(d.aliases.every(name => name.startsWith('web.')));
}
const calls = [];
const visibleCalls = [];
const visibleWorker = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  visibleCalls.push({ route: req.url, body: JSON.parse(raw) });
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true, status: 'VISIBLE_FIXTURE_OBSERVED' }));
});
visibleWorker.listen(0, '127.0.0.1');
await once(visibleWorker, 'listening');
const worker = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  calls.push({ route: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) });
  res.setHeader('content-type', 'application/json');
  const input = JSON.parse(raw);
  if (req.url === '/browser-status') {
    res.end(JSON.stringify({
      ok: true,
      runtime: {
        policy: { externalVisibleBrowser: true, browserMode: 'external-browser-cdp', maxFieldWrites: 80, maxFormFills: 20 },
        session: { fieldWriteCount: 80, formFillCount: 17 },
        browser: { pageCount: 4 },
      },
    }));
  } else if (req.url === '/browser-restart') {
    res.end(JSON.stringify({
      ok: true,
      after: { runtime: { session: { fieldWriteCount: 0, formFillCount: 0 }, browser: { pageCount: 4 } } },
    }));
  } else if (req.url === '/fill-after-approval' && input.approvalReceiptId === 'quota-fixture-receipt') {
    res.end(JSON.stringify({
      ok: false, status: 'WEB_OPERATION_LIMIT_REACHED',
      evidence: { kind: 'field-write', limit: 80, requestedWrites: 1 },
    }));
  } else if (input.selector === '#timeout-fixture') {
    // Stay pending beyond the bridge's default deadline; cancel when it aborts.
    const timer = setTimeout(() => res.end(JSON.stringify({ ok: true, status: 'WEB_FIXTURE_OBSERVED' })), 120000);
    res.once('close', () => clearTimeout(timer));
  } else res.end(JSON.stringify({ ok: true, status: req.url === '/browser-targets' ? 200 : 'WEB_FIXTURE_OBSERVED' }));
});
worker.listen(0, '127.0.0.1');
await once(worker, 'listening');
const oldUrl = process.env.BROWSER_MCP_BROWSER_WORKER_URL;
const oldVisibleUrl = process.env.BROWSER_MCP_VISIBLE_WORKER_URL;
const oldToken = process.env.BROWSER_MCP_BROWSER_WORKER_TOKEN;
process.env.BROWSER_MCP_BROWSER_WORKER_URL = `http://127.0.0.1:${worker.address().port}`;
process.env.BROWSER_MCP_VISIBLE_WORKER_URL = `http://127.0.0.1:${visibleWorker.address().port}`;
process.env.BROWSER_MCP_BROWSER_WORKER_TOKEN = 'fixture-only-not-a-production-secret';
try {
  const registered = new Map();
  registerWebDomainBridgeTools({ registerTool(name, config, handler) { registered.set(name, { config, handler }); } }, { mode: 'bearer', bearerTokens: ['fixture'] });
  assert.equal(registered.size, consoleWebDomainToolNames.length);
  const inputs = {
    'write.web.target.open': { url: 'https://example.invalid/fixture' },
    'write.web.job.open': { url: 'https://example.invalid/fixture' },
    'write.web.form.proposal.preview': { fields: [] },
    'write.web.form.fill': { approved: false, approvalText: '', fields: [] },
    'write.web.form.upload': { approved: false, approvalText: '', artifactRef: 'fixture.txt' },
    'write.web.form.submit': { approved: false, approvalText: '' },
  };
  const correlated = new Set(['web.click', 'web.fill_after_approval', 'web.upload_artifact', 'web.submit_after_approval']);
  for (const d of definitions) {
    const tool = registered.get(d.consoleName);
    assert.equal(tool.config.annotations.readOnlyHint, d.access === 'read');
    assert.doesNotMatch(tool.config.description, /unavailable/);
    const input = tool.config.inputSchema.parse({browserSession: 'isolated', ...(inputs[d.consoleName] ?? {})});
    const response = await runWithMcpRequestContext('web-bridge-regression', () => tool.handler(input));
    if (d.route === '/browser-targets') { const body = JSON.parse(response.content[0].text); assert.equal(body.http_status, 200); assert.equal(typeof body.status, 'string'); }
    const observed = calls.at(-1);
    assert.equal(observed.route, d.route);
    assert.equal(observed.authorization, 'Bearer fixture-only-not-a-production-secret');
    if (correlated.has(d.capabilityName)) assert.equal(observed.body.correlation.invocationId, 'web-bridge-regression');
    if ('approved' in input) assert.equal(observed.body.approved, false, 'Bridge must not grant approval.');
  }
  const capture = registered.get('read_.web.page.capture').config.inputSchema.parse({browserSession:'visible',targetId:'A'.repeat(32),screenshot:true});
  assert.equal(capture.targetId, 'A'.repeat(32));
  const visibleTool = registered.get('write.web.browser.bind');
  const visibleInput = visibleTool.config.inputSchema.parse({ browserSession: 'visible', targetId: 'test-visible-target' });
  assert.equal(visibleInput.browserSession, 'visible');
  const visibleResult = JSON.parse((await visibleTool.handler(visibleInput)).content[0].text);
  assert.equal(visibleResult.status, 'WEB_TARGET_NOT_FOUND_IN_ANY_SESSION', 'Exact binding must reject missing targets without session fallback.');
  assert.equal(visibleCalls.length, 0);
  process.env.BROWSER_MCP_VISIBLE_WORKER_URL = process.env.BROWSER_MCP_BROWSER_WORKER_URL;
  assert.equal(JSON.parse((await visibleTool.handler(visibleInput)).content[0].text).status, 'WEB_TARGET_NOT_FOUND_IN_ANY_SESSION');
  assert.equal(calls.length, consoleWebDomainToolNames.length + 2, 'Exact bind discovery only may reach isolated worker.');
  const click = registered.get('write.web.page.click');
  const timeoutInput = click.config.inputSchema.parse({ selector: '#timeout-fixture' });
  const timeout = JSON.parse((await click.handler(timeoutInput)).content[0].text);
  assert.equal(timeout.status, 'WEB_BROWSER_WORKER_TIMEOUT', 'A request deadline is not evidence of a dead worker.');
  assert.equal(timeout.outcome_unknown, true, 'Timed-out writes may still complete.');
  assert.equal(timeout.automatic_retry_allowed, false, 'Never duplicate a timed-out mutation automatically.');
  process.env.BROWSER_MCP_BROWSER_WORKER_URL = 'http://example.invalid:8791';
  const result = await registered.get('read_.web.form.inspect').handler({});
  assert.equal(JSON.parse(result.content[0].text).status, 'WEB_BROWSER_WORKER_CONFIGURATION_INVALID');
  assert.equal(calls.length, consoleWebDomainToolNames.length + 3, 'Non-loopback worker must never receive requests.');
  process.env.BROWSER_MCP_BROWSER_WORKER_URL = `http://127.0.0.1:${worker.address().port}`;
  const callStart = calls.length;
  const implicitVisible = JSON.parse((await registered.get('write.web.form.fill').handler({
    expectedTargetId: 'target-fixture',
  })).content[0].text);
  assert.equal(implicitVisible.status, 'WEB_BROWSER_WORKER_CONFIGURATION_INVALID',
    'An exact-target form write defaults to the pinned visible worker');
  assert.equal(calls.length, callStart, 'Visible configuration failure must not fall back to isolated');
  assert.equal(visibleCalls.length, 0, 'A non-pinned visible fixture endpoint must not receive requests');
  const quota = JSON.parse((await registered.get('write.web.form.fill').handler({
    browserSession: 'isolated',
    approved: true, approvalText: 'APPLY',
    approvalReceiptId: 'quota-fixture-receipt',
    expectedTargetId: 'target-fixture',
    fields: [{ controlId: 'fixture:field', value: 'test value' }],
  })).content[0].text);
  assert.equal(quota.status, 'WEB_SESSION_ROTATED_REINSPECT_REQUIRED');
  assert.equal(quota.ok, false, 'Rotation is not a successful fill.');
  assert.equal(quota.automatic_retry_allowed, false);
  assert.equal(quota.final_submit_replay_allowed, false);
  assert.equal(quota.requires_fresh_inspection_and_approval, true);
  assert.equal(quota.recovery.verified, true);
  assert.deepEqual(calls.slice(callStart).map(c => c.route),
    ['/fill-after-approval', '/browser-status', '/browser-restart'],
    'Never replay a rejected fill or submit after session rotation.');
  assert.equal(calls.at(-1).body.force, false, 'Never kill externally owned Edge.');
  assert.equal(classifyWebConsumerOutcome({ status: quota.status }).disposition, 'reinspect');

  for (const [status, disposition] of [['WEB_APPROVAL_REQUIRED', 'approval_required'], ['WEB_TARGET_STALE', 'reinspect'], ['WEB_SUBMIT_VERIFIED', 'terminal_success'], ['WEB_SUBMIT_POSTCONDITION_UNVERIFIED', 'terminal_uncertain']]) {
    const outcome = classifyWebConsumerOutcome({ status });
    assert.equal(outcome.disposition, disposition);
    assert.equal(outcome.automaticRetryAllowed, false);
  }
  console.log('Web domain bridge: PASS (17 schemas/routes, worker authentication, correlation, approval preservation, loopback guard, outcomes)');
} finally {
  if (oldUrl === undefined) delete process.env.BROWSER_MCP_BROWSER_WORKER_URL; else process.env.BROWSER_MCP_BROWSER_WORKER_URL = oldUrl;
  if (oldVisibleUrl === undefined) delete process.env.BROWSER_MCP_VISIBLE_WORKER_URL; else process.env.BROWSER_MCP_VISIBLE_WORKER_URL = oldVisibleUrl;
  if (oldToken === undefined) delete process.env.BROWSER_MCP_BROWSER_WORKER_TOKEN; else process.env.BROWSER_MCP_BROWSER_WORKER_TOKEN = oldToken;
  worker.close();
  visibleWorker.close();
  await Promise.all([once(worker, 'close'), once(visibleWorker, 'close')]);
}
