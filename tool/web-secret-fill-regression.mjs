import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, link, rm, access, lstat, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import { AsyncLocalStorage } from 'node:async_hooks';
import { chromium } from 'playwright';
import { installWebSecretFill, secretPlan, fillSecretElements, secretQuarantined } from '../ops/ubuntu/runtime/web-secret-fill.mjs';
import { resolveMcpSiblingRepository } from '../dist/service/mcp-sibling-repository.js';

const temp = await mkdtemp(resolve(tmpdir(), 'web-secret-fill-'));
let browser, server;
let count = 0;
const logs = [];
const originalConsole = Object.fromEntries(['log', 'warn', 'error', 'info', 'debug'].map(key => [key, console[key]]));
for (const key of Object.keys(originalConsole)) console[key] = (...args) => logs.push(args.map(String).join(' '));
const check = condition => { assert.equal(Boolean(condition), true); count++; };
const reject = async fn => { let refused = false; try { await fn(); } catch { refused = true; } check(refused); };
try {
  const root = resolve(temp, 'secrets');
  await mkdir(root, { mode: 0o700 });
  process.env.CONSOLE_WEB_SECRET_ROOT = root;
  // Synthetic, runtime-only credential: never print it, even in assertion diffs.
  const value = randomBytes(32).toString('hex');
  await writeFile(resolve(root, 'credential'), value, { mode: 0o600 });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', resolve(temp, 'key'),
    '-out', resolve(temp, 'cert'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  let submissions = 0;
  server = https.createServer({ key: await readFile(resolve(temp, 'key')), cert: await readFile(resolve(temp, 'cert')) }, (req, res) => {
    if (req.method !== 'GET') submissions++;
    res.end('<!doctype html><form method="post"><label>Vault passphrase<input id="credential" name="password" type="password"></label><label>Confirm passphrase<input id="confirmation" name="confirmation" type="password"></label><button>Register</button></form>');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `https://127.0.0.1:${server.address().port}`;
  const { getDeniedReason } = await import('../dist/Policy/PathGuard.js');
  const pathPolicy = { denyBasenames: [], denyExtensions: [], denyPathFragments: [], allowlist: [temp] };
  check(getDeniedReason(resolve(root, 'credential'), pathPolicy) === 'protected browser secret directory');
  await symlink(resolve(root, 'credential'), resolve(temp, 'alias'));
  check(getDeniedReason(resolve(temp, 'alias'), pathPolicy) === 'protected browser secret directory');
  const { readTextFile } = await import('../dist/Infrastructure/FileSystem/SafeFileSystem.js');
  const filePolicy = { deniedPath: pathPolicy, allowedRoots: [temp], maxFileBytes: 16384 };
  await reject(() => readTextFile(filePolicy, resolve(root, 'credential')));
  await reject(() => readTextFile(filePolicy, resolve(temp, 'alias')));
  const policyPath = resolve(root, 'local-test.json');
  const policy = { controlId: 'test-control', origin, secretFile: 'credential' };
  await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
  browser = await chromium.launch({ headless: true, executablePath: process.env.CONSOLE_TEST_CHROMIUM_EXECUTABLE || undefined });
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  page.on('console', message => logs.push(message.text()));
  page.on('pageerror', error => logs.push(error.message));
  await page.goto(origin);
  const locator = page.locator('#credential');
  const before = { targetId: 'a'.repeat(32), url: origin, pageRevision: 'page-1', formRevision: 'form-1', fields: [{ controlId: 'test-control', id: 'credential', name: 'password' }, { controlId: 'confirm-control', id: 'confirmation', name: 'confirmation' }] };
  const session = { ok: true, visibility_verified: true, user_interaction_ready: true,
    evidence: { targetId: before.targetId, browserInstance: 'test-instance', windowId: 'test-window', cdpWindowId: 1, endpoint: 'http://127.0.0.1:9224', browserPid: process.pid, userId: 'test-uid', guiSessionId: 'test-gui' } };
  const rootStat = await lstat(root);
  const body = { secretRootIdentity: `${rootStat.dev}:${rootStat.ino}`, expectedTargetId: before.targetId, expectedPageRevision: before.pageRevision,
    expectedFormRevision: before.formRevision, fields: [{ controlId: 'test-control', secretRef: 'local-test' }] };
  check(Boolean(await secretPlan(body, before, session)));
  for (const bad of [
    { ...body, expectedTargetId: 'b'.repeat(32) },
    { ...body, secretRootIdentity: 'wrong:directory' },
    { ...body, fields: [{ controlId: 'other', secretRef: 'local-test' }] },
    { ...body, fields: [{ controlId: 'test-control', secretRef: '../credential' }] },
    { ...body, fields: [{ ...body.fields[0], value: 'forbidden' }] },
  ]) await reject(() => secretPlan(bad, before, session));
  await reject(() => secretPlan(body, { ...before, url: 'http://127.0.0.1' }, session));
  await reject(() => secretPlan(body, { ...before, url: 'https://example.invalid' }, session));
  await reject(() => secretPlan(body, before, { ...session, visibility_verified: false }));
  await reject(() => secretPlan(body, { ...before, fields: [{ controlId: 'test-control', framePath: [0] }] }, session));
  await reject(() => secretPlan(body, before, { ...session, evidence: { ...session.evidence, endpoint: 'http://127.0.0.1:9223' } }));
  await reject(() => secretPlan(body, before, { ...session, user_interaction_ready: false }));
  await chmod(policyPath, 0o644);
  await reject(() => secretPlan(body, before, session));
  await chmod(policyPath, 0o600);
  await rm(policyPath);
  await symlink(resolve(root, 'credential'), policyPath);
  await reject(() => secretPlan(body, before, session));
  await rm(policyPath);
  await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
  await link(policyPath, resolve(root, 'hardlink'));
  await reject(() => secretPlan(body, before, session));
  await rm(resolve(root, 'hardlink'));
  process.env.DEBUG = 'pw:protocol';
  await reject(() => secretPlan(body, before, session));
  delete process.env.DEBUG;
  async function fillElement(nodeLocator, secret, allowedOrigin) {
    const handle = await nodeLocator.elementHandle();
    const form = await handle.evaluateHandle(node => node.form);
    try {
      const identity = await handle.evaluate(node => ({ id: node.id, name: node.name }));
      return await fillSecretElements(page, [handle], secret, allowedOrigin, [identity], form);
    } finally { await form.dispose(); await handle.dispose(); }
  }
  check(await fillElement(locator, value, origin));
  check(await locator.evaluate((node, expected) => node.value === expected, value));
  await locator.evaluate(node => { node.value = ''; node.type = 'text'; });
  check(!await fillElement(locator, value, origin));
  await locator.evaluate(node => { node.type = 'password'; });
  check(!await fillElement(locator, value, 'https://example.invalid'));
  await page.locator('form').evaluate(node => { node.action = 'https://example.invalid'; });
  check(!await fillElement(locator, value, origin));
  await page.locator('form').evaluate(node => { node.action = location.href; });
  const approval = await import(pathToFileURL(resolve(resolveMcpSiblingRepository('browsing'), 'playwright-worker/src/approval-receipt.js')));
  const routes = new Map();
  const visibleRequest = new AsyncLocalStorage();
  let writes = 0;
  let failWrite = false;
  let freshProof = session;
  let captures = 0;
  let staleDuringResolution = false;
  const policyConfig = { requireApprovalForFill: true, requireApprovalReceiptForFill: true,
    approvalReceiptRoot: resolve(temp, 'receipts'), approvalReceiptTtlMs: 60000 };
  installWebSecretFill({ post: (path, fn) => routes.set(path, fn) }, {
    getPolicy: () => policyConfig, ensurePage: async () => page, ensureNotChallenge: async () => {},
    capturePageArtifact: async () => {
      captures++;
      return staleDuringResolution && captures % 2 === 0 ? { ...before, formRevision: 'changed' } : before;
    }, visibleRequest,
    verifySession: async () => freshProof,
    resolveRequestedFieldLocator: async (_target, item) => {
      if (failWrite) throw Error(value);
      return { locator: page.locator(item.controlId === 'test-control' ? '#credential' : '#confirmation') };
    }, ...approval,
    quota: (commit, size) => { if (writes + size > 2) throw Error('quota'); if (commit) writes += size; },
  });
  async function call(route, input, proof = session) {
    captures = 0;
    let response;
    const res = { status() { return this; }, json(result) { response = result; } };
    await visibleRequest.run(proof, () => routes.get(route)({ body: input }, res));
    const serialized = JSON.stringify(response);
    check(!serialized.includes(value));
    const { createHash } = await import('node:crypto');
    check(!serialized.includes(createHash('sha256').update(value).digest('hex')));
    check(!/"(?:value|actual|requested|length|secretLength|valueLength|secretHash|valueHash|evidence)"\s*:/.test(serialized));
    return response;
  }
  const proposal = await call('/secret-propose', body);
  check(proposal.ok);
  const approved = { ...body, approved: true, approvalText: 'APPLY', approvalReceiptId: proposal.approvalReceipt.id };
  check(!(await call('/secret-fill', { ...approved, approved: false })).ok);
  check(!(await call('/secret-fill', approved, { ...session, visibility_verified: false })).ok);
  check(!(await call('/secret-fill', { ...approved, expectedFormRevision: 'stale' })).ok);
  check(!(await call('/secret-fill', { ...approved, fields: [{ controlId: 'other', secretRef: 'local-test' }] })).ok);
  check((await call('/secret-fill', approved)).ok);
  await access(resolve(root, 'quarantine'));
  const { enforceVisibleBrowserTools } = await import('../dist/service/visible-browser-tools.js');
  const guarded = new Map();
  let calls = 0;
  const gate = enforceVisibleBrowserTools({ registerTool(name, config, handler) { guarded.set(name, handler); } });
  for (const name of ['read_.web.page.capture', 'read_.web.browser.targets', 'write.web.form.fill', 'read_.browser.screenshot', 'write.engine.prompt.draft', 'read_.desktop.capture']) {
    gate.registerTool(name, {}, async () => { calls++; return {}; });
    const result = await guarded.get(name)({});
    check(JSON.parse(result.content[0].text).status === 'WEB_SECRET_LOCAL_CLEANUP_REQUIRED');
  }
  check(calls === 0);
  await chmod(root, 0o755);
  await reject(() => secretQuarantined(root));
  const invalidConfiguration = await guarded.get('read_.web.page.capture')({});
  check(JSON.parse(invalidConfiguration.content[0].text).status === 'WEB_SECRET_CONFIGURATION_REQUIRED');
  await chmod(root, 0o700);

  check(await locator.evaluate((node, expected) => node.value === expected, value));
  check(!(await call('/secret-fill', approved)).ok);
  check(submissions === 0);
  const files = await import('node:fs/promises');
  for (const name of await files.readdir(policyConfig.approvalReceiptRoot)) {
    check(!(await readFile(resolve(policyConfig.approvalReceiptRoot, name), 'utf8')).includes(value));
  }
  // Browser, origin, window and ref are all part of the receipt payload binding.
  await rm(resolve(root, 'quarantine'));
  writes = 0;
  const next = await call('/secret-propose', body);
  const nextBody = { ...approved, approvalReceiptId: next.approvalReceipt.id };
  check(!(await call('/secret-fill', nextBody, { ...session, evidence: { ...session.evidence, browserInstance: 'replaced' } })).ok);
  check(!(await call('/secret-fill', nextBody, { ...session, evidence: { ...session.evidence, windowId: 'moved' } })).ok);
  failWrite = true;
  check(!(await call('/secret-fill', nextBody)).ok);
  await reject(() => access(resolve(root, 'quarantine')));
  writes = 0;
  check(!(await call('/secret-fill', nextBody)).ok);
  // A consumed receipt cannot replay, even after quota and quarantine are reset locally.
  check(!(await call('/secret-fill', approved)).ok);
  failWrite = false;
  writes = 0;
  const pair = { ...body, fields: [body.fields[0], { controlId: 'confirm-control', secretRef: 'local-test' }] };
  await writeFile(policyPath, JSON.stringify({ origin, controlIds: ['test-control', 'confirm-control'], secretFile: 'credential' }), { mode: 0o600 });
  for (const fields of [[pair.fields[0]], [pair.fields[0], pair.fields[0]],
    [pair.fields[0], { ...pair.fields[1], secretRef: 'different' }],
    [pair.fields[0], { ...pair.fields[1], controlId: 'mismatched' }], [...pair.fields, pair.fields[0]]]) {
    await reject(() => secretPlan({ ...pair, fields }, before, session));
  }
  async function approvePair() {
    const preview = await call('/secret-propose', pair);
    check(preview.ok);
    return { ...pair, approved: true, approvalText: 'APPLY', approvalReceiptId: preview.approvalReceipt.id };
  }
  await page.locator('input').evaluateAll(nodes => nodes.forEach(node => { node.value = ''; }));
  const pairApproved = await approvePair();
  // Ownership and revisions must be checked again after resolving both locators.
  freshProof = { ...session, evidence: { ...session.evidence, userId: 'different-owner' } };
  check(!(await call('/secret-fill', pairApproved)).ok);
  await reject(() => access(resolve(root, 'quarantine')));
  freshProof = session;
  const staleApproved = await approvePair();
  staleDuringResolution = true;
  check(!(await call('/secret-fill', staleApproved)).ok);
  staleDuringResolution = false;
  await reject(() => access(resolve(root, 'quarantine')));
  const switched = await approvePair();
  freshProof = { ...session, evidence: { ...session.evidence, targetId: 'b'.repeat(32) } };
  check(!(await call('/secret-fill', switched)).ok);
  freshProof = session;
  await reject(() => access(resolve(root, 'quarantine')));
  const goodPair = await approvePair();
  check((await call('/secret-fill', goodPair)).ok);
  check(writes === 2);
  check(await page.locator('input').evaluateAll((nodes, expected) => nodes.length === 2 && nodes.every(node => node.value === expected), value));
  await access(resolve(root, 'quarantine'));
  const quarantineText = await readFile(resolve(root, 'quarantine'), 'utf8');
  check(!quarantineText.includes(value));
  check((await lstat(resolve(root, 'quarantine'))).mode % 512 === 0o600);
  check(!(await call('/secret-fill', goodPair)).ok);
  // Local test reset ONLY; production uses the guarded operator cleanup procedure.
  await rm(resolve(root, 'quarantine'));
  writes = 0;
  await page.locator('input').evaluateAll(nodes => nodes.forEach(node => { node.value = ''; }));
  const partial = await approvePair();
  // Simulate a page setter throwing on the second control after the first changed.
  await page.evaluate(() => {
    const original = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    window.restoreValueSetter = () => Object.defineProperty(HTMLInputElement.prototype, 'value', original);
    Object.defineProperty(HTMLInputElement.prototype, 'value', { ...original, set(value) {
      if (this.id === 'confirmation') throw Error(value);
      original.set.call(this, value);
    } });
  });
  check(!(await call('/secret-fill', partial)).ok);
  await access(resolve(root, 'quarantine'));
  check(await locator.evaluate((node, expected) => node.value === expected, value));
  check(await page.locator('#confirmation').evaluate(node => node.value === ''));
  check(!(await call('/secret-fill', partial)).ok);
  await page.evaluate(() => window.restoreValueSetter());
  const { cleanupQuarantine, browserClosed } = await import('../ops/ubuntu/runtime/web-secret-cleanup.mjs');
  const marker = JSON.parse(await readFile(resolve(root, 'quarantine'), 'utf8'));
  const cleanup = { operationId: marker.operationId, acknowledge: 'BROWSER_CLOSED_AND_LOCAL_TRACES_REVIEWED' };
  check(!await browserClosed(marker)); // Our isolated browser owner PID is still live; no CDP probe.
  await reject(() => cleanupQuarantine({ ...cleanup, acknowledge: 'RESET' }, async () => true));
  await reject(() => cleanupQuarantine({ ...cleanup, operationId: '0'.repeat(36) }, async () => true));
  await reject(() => cleanupQuarantine(cleanup, async () => false));
  await access(resolve(root, 'quarantine'));
  check((await cleanupQuarantine(cleanup, async record => record.operationId === marker.operationId)).ok);
  await reject(() => access(resolve(root, 'quarantine')));
  const auditText = await readFile(resolve(root, 'cleanup-audit', `${marker.operationId}.json`), 'utf8');
  check(!auditText.includes(value));
  check(JSON.parse(auditText).attestedByUid === process.getuid());
  check(JSON.parse(auditText).approvalReceiptId === partial.approvalReceiptId);
  check(JSON.parse(auditText).browserInstance === session.evidence.browserInstance);
  check(JSON.parse(auditText).acknowledgement === cleanup.acknowledge);
  writes = 0;
  check(!(await call('/secret-fill', partial)).ok); // Cleanup cannot revive the receipt.
  // Invalid/cross-origin controls are rejected before resolution or any mutation.
  await page.locator('input').evaluateAll(nodes => nodes.forEach(node => { node.value = ''; }));
  const invalidPair = await approvePair();
  await page.locator('#confirmation').evaluate(node => { node.disabled = true; });
  check(!(await call('/secret-fill', invalidPair)).ok);
  await reject(() => access(resolve(root, 'quarantine')));
  check(await page.locator('input').evaluateAll(nodes => nodes.every(node => node.value === '')));
  await page.locator('#confirmation').evaluate(node => { node.disabled = false; });
  writes = 0;
  const foreignForm = await approvePair();
  await page.locator('form').evaluate(node => { node.action = 'https://example.invalid'; });
  check(!(await call('/secret-fill', foreignForm)).ok);
  await reject(() => access(resolve(root, 'quarantine')));
  check(await page.locator('input').evaluateAll(nodes => nodes.every(node => node.value === '')));
  await page.locator('form').evaluate(node => { node.action = location.href; });
  const mismatchedForms = await approvePair();
  await page.evaluate(() => {
    const other = document.createElement('form'); other.id = 'other'; document.body.append(other);
    document.querySelector('#confirmation').setAttribute('form', 'other');
  });
  check(!(await call('/secret-fill', mismatchedForms)).ok);
  await reject(() => access(resolve(root, 'quarantine')));
  await page.locator('#confirmation').evaluate(node => node.removeAttribute('form'));
  await page.locator('#other').evaluate(node => node.remove());
  // Preview never resolves credentials; a missing credential fails closed only
  // after receipt consumption and durable quarantine, without changing either field.
  await rename(resolve(root, 'credential'), resolve(root, 'held-credential'));
  const unavailableSecret = await approvePair();
  check(!(await call('/secret-fill', unavailableSecret)).ok);
  await access(resolve(root, 'quarantine'));
  check(await page.locator('input').evaluateAll(nodes => nodes.every(node => node.value === '')));
  await rename(resolve(root, 'held-credential'), resolve(root, 'credential'));
  check(submissions === 0);
  check(!logs.some(line => line.includes(value)));
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(value).digest('hex');
  check(!logs.some(line => line.includes(digest)));
  for (const name of await files.readdir(policyConfig.approvalReceiptRoot)) {
    check(!(await readFile(resolve(policyConfig.approvalReceiptRoot, name), 'utf8')).includes(value));
  }
  for (const key of Object.keys(originalConsole)) console[key] = originalConsole[key];
  console.log(`Web Secret Fill: PASS (${count} assertions; atomic password/confirmation, partial quarantine, no submission or disclosure)`);
} catch {
  for (const key of Object.keys(originalConsole)) console[key] = originalConsole[key];
  // Deliberately omit exception details, assertion values and Playwright call logs.
  console.error(`Web Secret Fill: FAIL at assertion checkpoint ${count} (details suppressed to protect synthetic credential)`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise(done => server ? server.close(done) : done());
  await rm(temp, { recursive: true, force: true });
}
