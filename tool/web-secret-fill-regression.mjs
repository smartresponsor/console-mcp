import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, link, rm, access, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import { AsyncLocalStorage } from 'node:async_hooks';
import { chromium } from 'playwright';
import { installWebSecretFill, secretPlan, fillSecretElement } from '../ops/ubuntu/runtime/web-secret-fill.mjs';
import { resolveMcpSiblingRepository } from '../dist/service/mcp-sibling-repository.js';

const temp = await mkdtemp(resolve(tmpdir(), 'web-secret-fill-'));
let browser, server;
let count = 0;
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
    res.end('<!doctype html><form method="post"><label>Vault passphrase<input id="credential" type="password"></label><button>Save</button></form>');
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
  await page.goto(origin);
  const locator = page.locator('#credential');
  const before = { targetId: 'a'.repeat(32), url: origin, pageRevision: 'page-1', formRevision: 'form-1', fields: [{ controlId: 'test-control' }] };
  const session = { ok: true, visibility_verified: true, user_interaction_ready: true,
    evidence: { targetId: before.targetId, browserInstance: 'test-instance', windowId: 'test-window', cdpWindowId: 1, endpoint: 'http://127.0.0.1:9224' } };
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
  check(await fillSecretElement(locator, value, origin));
  check(await locator.evaluate((node, expected) => node.value === expected, value));
  await locator.evaluate(node => { node.value = ''; node.type = 'text'; });
  check(!await fillSecretElement(locator, value, origin));
  await locator.evaluate(node => { node.type = 'password'; });
  check(!await fillSecretElement(locator, value, 'https://example.invalid'));
  await page.locator('form').evaluate(node => { node.action = 'https://example.invalid'; });
  check(!await fillSecretElement(locator, value, origin));
  await page.locator('form').evaluate(node => { node.action = location.href; });
  const approval = await import(pathToFileURL(resolve(resolveMcpSiblingRepository('browsing'), 'playwright-worker/src/approval-receipt.js')));
  const routes = new Map();
  const visibleRequest = new AsyncLocalStorage();
  let writes = 0;
  let failWrite = false;
  const policyConfig = { requireApprovalForFill: true, requireApprovalReceiptForFill: true,
    approvalReceiptRoot: resolve(temp, 'receipts'), approvalReceiptTtlMs: 60000 };
  installWebSecretFill({ post: (path, fn) => routes.set(path, fn) }, {
    getPolicy: () => policyConfig, ensurePage: async () => page, ensureNotChallenge: async () => {},
    capturePageArtifact: async () => before, visibleRequest,
    resolveRequestedFieldLocator: async () => ({ locator: failWrite ? { evaluate: async () => { throw Error(value); } } : locator }), ...approval,
    quota: commit => { if (writes >= 1) throw Error('quota'); if (commit) writes++; },
  });
  async function call(route, input, proof = session) {
    let response;
    const res = { status() { return this; }, json(result) { response = result; } };
    await visibleRequest.run(proof, () => routes.get(route)({ body: input }, res));
    check(!JSON.stringify(response).includes(value));
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
  await access(resolve(root, 'quarantine'));
  await rm(resolve(root, 'quarantine'));
  writes = 0;
  check(!(await call('/secret-fill', nextBody)).ok);
  // A consumed receipt cannot replay, even after quota and quarantine are reset locally.
  check(!(await call('/secret-fill', approved)).ok);
  console.log(`Web Secret Fill: PASS (${count} assertions; isolated local HTTPS page; no submission or secret output)`);
} catch {
  // Deliberately omit exception details, assertion values and Playwright call logs.
  console.error(`Web Secret Fill: FAIL at assertion checkpoint ${count} (details suppressed to protect synthetic credential)`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise(done => server ? server.close(done) : done());
  await rm(temp, { recursive: true, force: true });
}
