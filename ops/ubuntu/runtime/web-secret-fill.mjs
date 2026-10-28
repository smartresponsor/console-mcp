// Trusted worker only. Never import into a public gateway or MCP argument mapper.
import { constants } from 'node:fs';
import { open, lstat, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const denied = () => new Error('WEB_SECRET_FILL_DENIED');
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
export function secretRoot() {
  const root = process.env.CONSOLE_WEB_SECRET_ROOT;
  if (!root || !root.startsWith('/')) throw denied();
  return resolve(root);
}
async function privateDirectory(root) {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)
      || await realpath(root) !== root) throw denied();
}
async function privateRead(root, file) {
  await privateDirectory(root);
  const handle = await open(resolve(root, file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.nlink !== 1 || stat.size > 16384) throw denied();
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}
export function normalizeSecretFields(fields) {
  if (!Array.isArray(fields) || fields.length !== 1) throw denied();
  const field = fields[0];
  if (!field || Object.keys(field).sort().join(',') !== 'controlId,secretRef'
      || !validId(field.secretRef) || typeof field.controlId !== 'string' || !field.controlId || field.controlId.length > 200) throw denied();
  return [{ controlId: field.controlId, secretRef: field.secretRef }];
}
export function secretHash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export async function secretPlan(body, before, session, root = secretRoot()) {
  if (process.platform !== 'linux' || process.env.DEBUG || process.env.PWDEBUG || process.env.NODE_OPTIONS
      || process.env.NODE_V8_COVERAGE || process.env.PLAYWRIGHT_TRACE_DIR) throw denied();
  await privateDirectory(root);
  const directory = await lstat(root);
  if (body.secretRootIdentity !== `${directory.dev}:${directory.ino}`) throw denied();
  const fields = normalizeSecretFields(body.fields);
  if (session?.ok !== true || session.visibility_verified !== true || session.user_interaction_ready !== true
      || !session.evidence?.browserInstance || !session.evidence?.windowId
      || session.evidence.endpoint !== 'http://127.0.0.1:9224'
      || session.evidence.targetId !== before.targetId || body.expectedTargetId !== before.targetId) throw denied();
  const url = new URL(before.url);
  if (url.protocol !== 'https:' || url.username || url.password) throw denied();
  const policy = JSON.parse(await privateRead(root, `${fields[0].secretRef}.json`));
  if (Object.keys(policy).sort().join(',') !== 'controlId,origin,secretFile' || !validId(policy.secretFile)
      || policy.origin !== url.origin || policy.controlId !== fields[0].controlId) throw denied();
  const field = before.fields.find(field => field.controlId === policy.controlId);
  // Only a unique top-level password input is supported initially; no iframe or selector fallback.
  if (!field || (Array.isArray(field.framePath) && field.framePath.length !== 0) || before.fields.filter(field => field.controlId === policy.controlId).length !== 1) throw denied();
  return { fields, origin: url.origin, policy, field, binding: {
    targetId: before.targetId, pageRevision: before.pageRevision, formRevision: before.formRevision,
    browserInstance: session.evidence.browserInstance, windowId: session.evidence.windowId,
    cdpWindowId: session.evidence.cdpWindowId, endpoint: session.evidence.endpoint,
    origin: url.origin, fields,
  } };
}

// No Playwright fill/value evidence: a single synchronous browser evaluation validates
// identity and writes, without firing events or submitting. All failures are opaque.
export async function fillSecretElement(locator, value, origin) {
  return locator.evaluate((node, data) => {
    if (window !== window.top || location.origin !== data.origin || node.ownerDocument !== document || node.getRootNode() !== document
        || node.tagName !== 'INPUT' || node.type !== 'password' || node.disabled || node.readOnly
        || !node.isConnected || !node.getClientRects().length || getComputedStyle(node).visibility !== 'visible'
        || (node.form && new URL(node.form.action, location.href).origin !== data.origin)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(node, data.value);
    return node.value === data.value;
  }, { value, origin });
}

export function installWebSecretFill(app, deps) {
  const { getPolicy, ensurePage, ensureNotChallenge, capturePageArtifact, visibleRequest,
    resolveRequestedFieldLocator, createApprovalReceipt, consumeApprovalReceipt, quota } = deps;
  for (const [route, execute] of [['/secret-propose', false], ['/secret-fill', true]]) {
    app.post(route, async (req, res) => {
      let attempted = false;
      try {
        const root = secretRoot();
        const policy = getPolicy();
        if (!policy.requireApprovalForFill || !policy.requireApprovalReceiptForFill) throw denied();
        if (execute && (req.body.approved !== true || req.body.approvalText !== 'APPLY')) throw denied();
        const target = await ensurePage();
        await ensureNotChallenge(target);
        const before = await capturePageArtifact(target, { screenshot: false });
        const plan = await secretPlan(req.body, before, visibleRequest.getStore(), root);
        const receiptArgs = { root: policy.approvalReceiptRoot, kind: 'secret-fill',
          targetId: before.targetId, pageRevision: before.pageRevision, formRevision: before.formRevision,
          payloadHash: secretHash(plan.binding), ttlMs: policy.approvalReceiptTtlMs };
        if (!execute) {
          const approvalReceipt = await createApprovalReceipt(receiptArgs);
          return res.json({ ok: true, status: 'WEB_SECRET_PROPOSAL_READY', approvalReceipt,
            targetId: before.targetId, pageRevision: before.pageRevision, formRevision: before.formRevision,
            fields: plan.fields, origin: plan.origin });
        }
        if (req.body.expectedPageRevision !== before.pageRevision || req.body.expectedFormRevision !== before.formRevision) throw denied();
        quota(false);
        await consumeApprovalReceipt({ ...receiptArgs, id: req.body.approvalReceiptId });
        const resolved = await resolveRequestedFieldLocator(target, plan.fields[0], before.fields);
        // Persist quarantine BEFORE resolution, including uncertain outcomes. Only local
        // operator cleanup may remove this file; no MCP route can clear it.
        await writeFile(resolve(root, 'quarantine'), 'LOCAL_BROWSER_CLEANUP_REQUIRED\n', { flag: 'wx', mode: 0o600 });
        attempted = true;
        quota(true);
        let value = await privateRead(root, plan.policy.secretFile);
        try {
          if (!value || value.length > 4096 || /[\r\n\0]/.test(value)) throw denied();
          if (!await fillSecretElement(resolved.locator, value, plan.origin)) throw denied();
        } finally { value = ''; }
        return res.json({ ok: true, status: 'WEB_SECRET_FILL_VERIFIED', local_cleanup_required: true, automatic_retry_allowed: false });
      } catch {
        return res.status(409).json({ ok: false, status: 'WEB_SECRET_FILL_DENIED',
          outcome_unknown: attempted, automatic_retry_allowed: false });
      }
    });
  }
}
