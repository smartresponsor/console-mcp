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
assert.equal(loaded.definition_count, 15);
const definitions = createRequire(import.meta.url)(`${resolveMcpSiblingRepository('browsing')}/mcp-server/src/web-domain-tool-definitions.cjs`).createWebCoreDomainToolDefinitions();
assert.deepEqual(new Set(definitions.map(d => d.consoleName)), new Set(consoleWebDomainToolNames));
for (const d of definitions) {
  assert.match(d.canonicalName, /^web\./);
  assert.match(d.capabilityName, /^web\./);
  assert.ok(d.aliases.every(name => name.startsWith('web.')));
}
const calls = [];
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
      ok: false,
      status: 'WEB_OPERATION_LIMIT_REACHED',
      evidence: { kind: 'field-write', limit: 80, requestedWrites: 1 },
    }));
  } else if (input.selector === '#timeout-fixture') {
    // Keep the socket active past the explicit 1000ms operation + 5000ms transport
    // grace. Inactivity timeouts would incorrectly accept the eventual response.
    const heartbeat = setInterval(() => res.write(' '), 100);
    const completion = setTimeout(() => res.end(JSON.stringify({ ok: true, status: 'WEB_FIXTURE_OBSERVED' })), 8000);
    res.on('close', () => { clearInterval(heartbeat); clearTimeout(completion); });
  } else res.end(JSON.stringify({ ok: true, status: 'WEB_FIXTURE_OBSERVED' }));
});
worker.listen(0, '127.0.0.1');
await once(worker, 'listening');
const oldUrl = process.env.BROWSER_MCP_BROWSER_WORKER_URL;
const oldToken = process.env.BROWSER_MCP_BROWSER_WORKER_TOKEN;
process.env.BROWSER_MCP_BROWSER_WORKER_URL = `http://127.0.0.1:${worker.address().port}`;
process.env.BROWSER_MCP_BROWSER_WORKER_TOKEN = 'fixture-only-not-a-production-secret';
try {
  const registered = new Map();
  registerWebDomainBridgeTools({ registerTool(name, config, handler) { registered.set(name, { config, handler }); } }, { mode: 'bearer', bearerTokens: ['fixture'] });
  assert.equal(registered.size, 15);
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
    const input = tool.config.inputSchema.parse(inputs[d.consoleName] ?? {});
    await runWithMcpRequestContext('web-bridge-regression', () => tool.handler(input));
    const observed = calls.at(-1);
    assert.equal(observed.route, d.route);
    assert.equal(observed.authorization, 'Bearer fixture-only-not-a-production-secret');
    if (correlated.has(d.capabilityName)) assert.equal(observed.body.correlation.invocationId, 'web-bridge-regression');
    if ('approved' in input) assert.equal(observed.body.approved, false, 'Bridge must not grant approval.');
  }
  const started = performance.now();
  const timeout = JSON.parse((await registered.get('write.web.page.click').handler({ selector: '#timeout-fixture', timeoutMs: 1000 })).content[0].text);
  assert.ok(performance.now() - started >= 5900, 'The operation deadline includes transport grace.');
  assert.ok(performance.now() - started < 8000, 'Active socket traffic must not extend the absolute deadline.');
  assert.equal(timeout.status, 'WEB_BROWSER_WORKER_TIMEOUT', 'A request deadline is not evidence of a dead worker.');
  assert.equal(timeout.outcome_unknown, true, 'Timed-out writes may still complete.');
  assert.equal(timeout.automatic_retry_allowed, false, 'Never duplicate a timed-out mutation automatically.');
  process.env.BROWSER_MCP_BROWSER_WORKER_URL = 'http://example.invalid:8791';
  const result = await registered.get('read_.web.form.inspect').handler({});
  assert.equal(JSON.parse(result.content[0].text).status, 'WEB_BROWSER_WORKER_CONFIGURATION_INVALID');
  assert.equal(calls.length, 16, 'Non-loopback worker must never receive requests.');
  process.env.BROWSER_MCP_BROWSER_WORKER_URL = `http://127.0.0.1:${worker.address().port}`;
  const callStart = calls.length;
  const quota = JSON.parse((await registered.get('write.web.form.fill').handler({
    approved: true,
    approvalText: 'APPLY',
    approvalReceiptId: 'quota-fixture-receipt',
    expectedTargetId: 'target-fixture',
    fields: [{ controlId: 'fixture:field', value: 'test value' }],
  })).content[0].text);
  assert.equal(quota.status, 'WEB_SESSION_ROTATED_REINSPECT_REQUIRED');
  assert.equal(quota.ok, false, 'A rotated session is not a successful fill.');
  assert.equal(quota.automatic_retry_allowed, false);
  assert.equal(quota.final_submit_replay_allowed, false);
  assert.equal(quota.requires_fresh_inspection_and_approval, true);
  assert.equal(quota.recovery.verified, true);
  assert.deepEqual(calls.slice(callStart).map(c => c.route), [
    '/fill-after-approval', '/browser-status', '/browser-restart',
  ], 'Quota rollover must not replay the rejected field mutation or submit.');
  assert.equal(calls.at(-1).body.force, false, 'External Edge must never be force-killed.');
  const rotated = classifyWebConsumerOutcome({ status: quota.status });
  assert.equal(rotated.disposition, 'reinspect');
  assert.equal(rotated.automaticRetryAllowed, false);
  for (const [status, disposition] of [['WEB_APPROVAL_REQUIRED', 'approval_required'], ['WEB_TARGET_STALE', 'reinspect'], ['WEB_SUBMIT_VERIFIED', 'terminal_success'], ['WEB_SUBMIT_POSTCONDITION_UNVERIFIED', 'terminal_uncertain']]) {
    const outcome = classifyWebConsumerOutcome({ status });
    assert.equal(outcome.disposition, disposition);
    assert.equal(outcome.automaticRetryAllowed, false);
  }
  console.log('Web domain bridge: PASS (15 schemas/routes, worker authentication, correlation, approval preservation, loopback guard, outcomes)');
} finally {
  if (oldUrl === undefined) delete process.env.BROWSER_MCP_BROWSER_WORKER_URL; else process.env.BROWSER_MCP_BROWSER_WORKER_URL = oldUrl;
  if (oldToken === undefined) delete process.env.BROWSER_MCP_BROWSER_WORKER_TOKEN; else process.env.BROWSER_MCP_BROWSER_WORKER_TOKEN = oldToken;
  worker.close();
  await once(worker, 'close');
}
