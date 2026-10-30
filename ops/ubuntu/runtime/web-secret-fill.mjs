// Trusted worker only. Never import into a public gateway or MCP argument mapper.
import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const denied = () => new Error('WEB_SECRET_FILL_DENIED');
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
export function secretRoot() {
  const root = process.env.CONSOLE_WEB_SECRET_ROOT;
  if (!root || !root.startsWith('/')) throw denied();
  return resolve(root);
}
export async function privateDirectory(root) {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)
      || await realpath(root) !== root) throw denied();
}
export async function secretQuarantined(root) {
  await privateDirectory(root);
  try { await lstat(resolve(root, 'quarantine')); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw denied(); }
}
export async function privateRead(root, file) {
  await privateDirectory(root);
  const handle = await open(resolve(root, file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.nlink !== 1 || stat.size > 16384) throw denied();
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}
export function normalizeSecretFields(fields) {
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 2) throw denied();
  for (const field of fields) {
    if (!field || Object.keys(field).sort().join(',') !== 'controlId,secretRef'
        || !validId(field.secretRef) || typeof field.controlId !== 'string' || !field.controlId || field.controlId.length > 200) throw denied();
  }
  if (new Set(fields.map(field => field.controlId)).size !== fields.length
      || fields.some(field => field.secretRef !== fields[0].secretRef)) throw denied();
  return fields.map(({ controlId, secretRef }) => ({ controlId, secretRef }));
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
  const keys = Object.keys(policy).sort().join(',');
  const allowed = keys === 'controlId,origin,secretFile' ? [policy.controlId]
    : keys === 'controlIds,origin,secretFile' && Array.isArray(policy.controlIds) ? policy.controlIds : [];
  if (!validId(policy.secretFile) || policy.origin !== url.origin || allowed.length !== fields.length
      || new Set(allowed).size !== allowed.length || fields.some(field => !allowed.includes(field.controlId))) throw denied();
  const snapshots = fields.map(item => before.fields.filter(field => field.controlId === item.controlId));
  if (snapshots.some(matches => matches.length !== 1 || (matches[0].framePath?.length ?? 0) !== 0)) throw denied();
  return { fields, origin: url.origin, policy, binding: {
    targetId: before.targetId, pageRevision: before.pageRevision, formRevision: before.formRevision,
    browserInstance: session.evidence.browserInstance, windowId: session.evidence.windowId,
    cdpWindowId: session.evidence.cdpWindowId, endpoint: session.evidence.endpoint,
    owner: Object.fromEntries(['userId', 'interactiveUser', 'guiSessionId', 'browserPid',
      'processStartedAt', 'profile', 'runtimeOwner'].map(key => [key, session.evidence[key] ?? null])),
    origin: url.origin, fields,
  } };
}

// All handles are resolved before reading the secret. One synchronous evaluation
// validates the complete set, writes both nodes and returns ONLY a boolean. No
// inter-request quarantine check, events, awaits, clicks or submits occur inside.
export async function fillSecretElements(target, handles, value, origin, identities, form, write = true) {
  return target.evaluate(data => {
    const nodes = data.nodes;
    if (window !== window.top || location.origin !== data.origin || new Set(nodes).size !== nodes.length) return false;
    if (nodes.some(node => node.form !== data.form)) return false;
    if (nodes.length === 2 && (!nodes[0].form || nodes[0].form !== nodes[1].form)) return false;
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index], identity = data.identities[index];
      if (node.ownerDocument !== document || node.getRootNode() !== document || node.tagName !== 'INPUT'
          || node.type !== 'password' || node.disabled || node.readOnly || !node.isConnected
          || !node.getClientRects().length || getComputedStyle(node).visibility !== 'visible'
          || node.id !== identity.id || node.name !== identity.name
          || (node.form && new URL(node.form.action, location.href).origin !== data.origin)) return false;
    }
    if (!data.write) return true;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    for (const node of nodes) setter.call(node, data.value);
    return nodes.every(node => node.value === data.value);
  }, { nodes: handles, value, origin, identities, form, write });
}

async function quarantine(root, session, approvalReceiptId) {
  const record = { schemaVersion: 1, operationId: randomUUID(), approvalReceiptId, startedAt: new Date().toISOString(),
    targetId: session.evidence.targetId, browserInstance: session.evidence.browserInstance,
    browserPid: session.evidence.browserPid, workerPid: process.pid, endpoint: session.evidence.endpoint };
  if (!Number.isInteger(record.browserPid) || record.browserPid <= 0) throw denied();
  const file = await open(resolve(root, 'quarantine'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(record) + '\n'); await file.sync(); } finally { await file.close(); }
  const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await directory.sync(); } finally { await directory.close(); }
}

export function installWebSecretFill(app, deps) {
  const { getPolicy, ensurePage, ensureNotChallenge, capturePageArtifact, visibleRequest,
    resolveRequestedFieldLocator, createApprovalReceipt, consumeApprovalReceipt, quota, verifySession } = deps;
  for (const [route, execute] of [['/secret-propose', false], ['/secret-fill', true]]) {
    app.post(route, async (req, res) => {
      let attempted = false;
      const handles = [];
      let form;
      try {
        const root = secretRoot();
        const policy = getPolicy();
        if (!policy.requireApprovalForFill || !policy.requireApprovalReceiptForFill) throw denied();
        if (execute && (req.body.approved !== true || req.body.approvalText !== 'APPLY')) throw denied();
        const target = await ensurePage();
        await ensureNotChallenge(target);
        const before = await capturePageArtifact(target, { screenshot: false });
        const session = visibleRequest.getStore();
        const plan = await secretPlan(req.body, before, session, root);
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
        quota(false, plan.fields.length);
        await consumeApprovalReceipt({ ...receiptArgs, id: req.body.approvalReceiptId });
        for (const item of plan.fields) {
          const resolved = await resolveRequestedFieldLocator(target, item, before.fields);
          const handle = await resolved.locator.elementHandle();
          if (!handle) throw denied();
          handles.push(handle);
        }
        form = await handles[0].evaluateHandle(node => node.form);
        // Re-prove ownership and revisions after asynchronous locator resolution.
        const freshSession = await verifySession(target, session);
        const current = await capturePageArtifact(target, { screenshot: false });
        const freshPlan = await secretPlan(req.body, current, freshSession, root);
        if (secretHash(freshPlan.binding) !== secretHash(plan.binding)) throw denied();
        const identities = plan.fields.map(item => {
          const field = before.fields.find(field => field.controlId === item.controlId);
          if (typeof field.id !== 'string' || typeof field.name !== 'string') throw denied();
          return { id: field.id, name: field.name };
        });
        if (!await fillSecretElements(target, handles, null, plan.origin, identities, form, false)) throw denied();
        await quarantine(root, session, req.body.approvalReceiptId);
        attempted = true;
        quota(true, plan.fields.length);
        let value = await privateRead(root, plan.policy.secretFile);
        try {
          if (!value || value.length > 4096 || /[\r\n\0]/.test(value)) throw denied();
          if (!await fillSecretElements(target, handles, value, plan.origin, identities, form)) throw denied();
        } finally { value = ''; }
        return res.json({ ok: true, status: 'WEB_SECRET_FILL_VERIFIED', local_cleanup_required: true, automatic_retry_allowed: false });
      } catch {
        return res.status(409).json({ ok: false, status: 'WEB_SECRET_FILL_DENIED',
          outcome_unknown: attempted, automatic_retry_allowed: false });
      } finally {
        if (form) { try { await form.dispose(); } catch { /* no diagnostics */ } }
        for (const handle of handles) { try { await handle.dispose(); } catch { /* no diagnostics */ } }
      }
    });
  }
}
