// Local operator only: intentionally has no MCP tool or worker reset endpoint.
import { constants } from 'node:fs';
import { open, mkdir, lstat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { connect } from 'node:net';
import { privateDirectory, privateRead, secretRoot } from './web-secret-fill.mjs';

const refuse = () => new Error('WEB_SECRET_CLEANUP_DENIED');
const acknowledgement = 'BROWSER_CLOSED_AND_LOCAL_TRACES_REVIEWED';
export async function browserClosed(record) {
  // ESRCH is the only acceptable process probe failure. Reused PIDs fail closed.
  for (const pid of new Set([record.browserPid, record.workerPid])) {
    try { process.kill(pid, 0); return false; } catch (error) {
      if (error.code !== 'ESRCH') return false;
    }
  }
  return new Promise(done => {
    const socket = connect({ host: '127.0.0.1', port: 9224 });
    socket.setTimeout(1500);
    socket.once('connect', () => { socket.destroy(); done(false); });
    socket.once('timeout', () => { socket.destroy(); done(false); });
    socket.once('error', error => { socket.destroy(); done(error.code === 'ECONNREFUSED'); });
  });
}
export async function cleanupQuarantine({ operationId, acknowledge }, confirmClosed = browserClosed) {
  const root = secretRoot();
  await privateDirectory(root);
  if (acknowledge !== acknowledgement || !/^[0-9a-f-]{36}$/.test(operationId ?? '')) throw refuse();
  // Serialize local cleanup. A failed attempt leaves quarantine untouched.
  const lock = await open(resolve(root, 'cleanup.lock'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const marker = resolve(root, 'quarantine');
    const identity = await lstat(marker);
    const record = JSON.parse(await privateRead(root, 'quarantine'));
    if (Object.keys(record).sort().join(',') !== 'approvalReceiptId,browserInstance,browserPid,endpoint,operationId,schemaVersion,startedAt,targetId,workerPid'
        || record.schemaVersion !== 1 || record.operationId !== operationId
        || !/^apr_[0-9a-f-]{36}$/i.test(record.approvalReceiptId ?? '')
        || !/^[0-9a-f]{32}$/i.test(record.targetId ?? '') || typeof record.browserInstance !== 'string' || !record.browserInstance
        || typeof record.startedAt !== 'string' || !Number.isFinite(Date.parse(record.startedAt))
        || record.endpoint !== 'http://127.0.0.1:9224' || !Number.isInteger(record.browserPid) || record.browserPid <= 0
        || !Number.isInteger(record.workerPid) || record.workerPid <= 0
        || !await confirmClosed(record)) throw refuse();
    const directory = resolve(root, 'cleanup-audit');
    await mkdir(directory, { mode: 0o700, recursive: true });
    await privateDirectory(directory);
    // Audit is durable BEFORE removal, contains pre-fill identity only, and
    // never reads the credential file or browser DOM/history/clipboard.
    const audit = await open(resolve(directory, `${operationId}.json`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await audit.writeFile(JSON.stringify({ schemaVersion: 1, operationId, closedBrowserPid: record.browserPid, closedWorkerPid: record.workerPid,
        targetId: record.targetId, approvalReceiptId: record.approvalReceiptId,
        browserInstance: record.browserInstance, endpoint: record.endpoint, startedAt: record.startedAt, attestedByUid: process.getuid(), acknowledgement,
        acknowledgedAt: new Date().toISOString(), action: 'quarantine-release-authorized' }) + '\n');
      await audit.sync();
    } finally { await audit.close(); }
    const auditDirectory = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await auditDirectory.sync(); } finally { await auditDirectory.close(); }
    const current = await lstat(marker);
    if (identity.dev !== current.dev || identity.ino !== current.ino || !await confirmClosed(record)) throw refuse();
    await unlink(marker);
    const rootDirectory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await rootDirectory.sync(); } finally { await rootDirectory.close(); }
    return { ok: true, status: 'WEB_SECRET_LOCAL_CLEANUP_RECORDED' };
  } finally {
    await lock.close();
    await unlink(resolve(root, 'cleanup.lock'));
  }
}
