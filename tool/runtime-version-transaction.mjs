import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { atomicJson, readJson, resolveVersion } from './runtime-version-store.mjs';
import { probe } from './runtime-mcp-probe.mjs';

const guardianFile = fileURLToPath(new URL('./runtime-candidate-guardian.mjs', import.meta.url));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function isolatedPort(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || [3333,3334,3335,8000,8080,9222,9223].includes(port)) throw Error('protected_or_invalid_port');
}
async function freePort(port) {
  isolatedPort(port);
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
}

export async function startCandidate(version, { port, workspace, token, memoryBytes = 0 }) {
  await freePort(port);
  await mkdir(workspace, { recursive: true });
  // No inherited runtime/profile secrets or production configuration.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^CONSOLE_MCP_/i.test(key)));
  Object.assign(env, { CONSOLE_MCP_MANAGED_RUNTIME: 'smoke-test', CONSOLE_MCP_AUTH_MODE: 'bearer',
    CONSOLE_MCP_HOST: '127.0.0.1', CONSOLE_MCP_PORT: String(port), CONSOLE_MCP_BEARER_TOKEN: token,
    CONSOLE_MCP_WORKSPACE_ROOT: workspace, CONSOLE_MCP_TRANSCRIPT_DIR: path.join(workspace, 'transcript') });
  const guardian = fork(guardianFile, [], { windowsHide: true, stdio: ['ignore','ignore','ignore','ipc'] });
  const exited = new Promise(resolve => guardian.once('exit', resolve));
  let startedInfo;
  const stop = async () => {
    if (guardian.exitCode === null && guardian.signalCode === null) {
      if (guardian.connected) guardian.send({ type: 'stop' });
      await Promise.race([exited, delay(10000, undefined, { ref: false }).then(() => { throw Error('guardian_cleanup_timeout'); })]);
    }
    const owned=[startedInfo?.pid,startedInfo?.containmentPid].filter(Boolean);
    for(let i=0;owned.some(alive)&&i<150;i++)await delay(100);
    if(owned.some(alive))throw Error('contained_cleanup_unverified');
  };
  try {
    const started = new Promise((resolve, reject) => {
      guardian.once('error', reject);
      guardian.once('exit', () => reject(Error('candidate_startup_failed')));
      guardian.once('message', message => message.type === 'started' ? resolve(message) : reject(Error('candidate_startup_failed')));
    });
    guardian.send({ type: 'start', root: version.root, entry: version.entry, env, memoryBytes });
    const message = await Promise.race([started, delay(30000, undefined, { ref: false }).then(() => { throw Error('contained_startup_timeout'); })]);
    startedInfo=message;
    return { pid: message.pid, guardianPid: guardian.pid, containmentPid: message.containmentPid, stop, alive: () => guardian.exitCode === null && guardian.signalCode === null };
  } catch (error) { await stop(); throw error; }
}

async function acquire(base) {
  const lock = path.join(base, 'lock');
  await mkdir(base, { recursive: true });
  try { await mkdir(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await readJson(path.join(lock, 'owner.json'));
    if (alive(owner.pid)) throw Error('transaction_locked');
    // Only stale controller locks; never kill a process from a persisted PID.
    await rm(lock, { recursive: true });
    await mkdir(lock);
  }
  await atomicJson(path.join(lock, 'owner.json'), { pid: process.pid });
  return () => rm(lock, { recursive: true });
}

async function verifyPrevious(previous) {
  const version = await resolveVersion(previous.reference);
  const health = await probe(previous);
  if (health.pid !== previous.pid || path.resolve(health.cwd) !== version.root) throw Error('previous_process_identity_mismatch');
  return health;
}

async function recoverLocked(base, previous) {
  const journalFile = path.join(base, 'transaction.json');
  let journal;
  try { journal = await readJson(journalFile); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if (journal.phase === 'rolled-back') return;
  if (!equal(journal.previous, previous.reference)) throw Error('recovery_previous_mismatch');
  // Guardian loses its IPC lease on a controller crash. Wait, never kill by PID.
  const owned = [journal.candidatePid, journal.guardianPid, journal.containmentPid].filter(Boolean);
  for (let i = 0; owned.some(alive) && i < 150; i++) await delay(100);
  if (owned.some(alive)) throw Error('candidate_cleanup_unverified');
  await freePort(journal.port);
  await verifyPrevious(previous);
  const active = await readJson(path.join(base, 'active.json'));
  if (!equal(active, journal.previous) && !equal(active, journal.candidate)) throw Error('selector_concurrent_change');
  await atomicJson(path.join(base, 'active.json'), journal.previous);
  await atomicJson(journalFile, { ...journal, phase: 'rolled-back', recovered: true });
}

export async function recover(base, previous) {
  const release = await acquire(base);
  try { await recoverLocked(base, previous); } finally { await release(); }
}

// This controller deliberately supports only isolated blue/green selection.
// Production routing/port transfer is a separate, explicitly authorized gate.
export async function cutover({ base, previous, candidate, port, workspace, timeoutMs = 20000, checkpoint = async () => {}, onRollback = () => {}, routing }) {
  isolatedPort(port);
  if (port === previous.port || !path.isAbsolute(base) || !path.isAbsolute(workspace)) throw Error('invalid_isolation');
  const release = await acquire(base);
  const activeFile = path.join(base, 'active.json');
  const journalFile = path.join(base, 'transaction.json');
  let child, journal, completed = false, timer, rollingBack;
  const rollback = () => rollingBack ??= (async () => {
    if (completed) return;
    clearInterval(timer);
    if (child) await child.stop();
    if (journal) {
      await verifyPrevious(previous);
      const active = await readJson(activeFile);
      if (!equal(active, previous.reference) && !equal(active, candidate)) throw Error('selector_concurrent_change');
      if (!equal(active, previous.reference)) await atomicJson(activeFile, previous.reference);
      await atomicJson(journalFile, { ...journal, phase: 'rolled-back' });
    }
    completed = true;
    await release();
    onRollback({ ok: true, status: 'rolled-back', previousPid: previous.pid });
  })().catch(error => { rollingBack = undefined; throw error; });
  try {
    await recoverLocked(base, previous);
    if (!equal(await readJson(activeFile), previous.reference)) throw Error('selector_previous_mismatch');
    await verifyPrevious(previous);
    const version = await resolveVersion(candidate);
    journal = { schema: 1, phase: 'prepared', previous: previous.reference, candidate, previousPid: previous.pid, port };
    await atomicJson(journalFile, journal);
    await checkpoint('prepared');
    const token = randomBytes(32).toString('hex');
    child = await startCandidate(version, { port, workspace, token });
    if(routing)routing.register(candidate,{port,token});
    journal = { ...journal, candidatePid: child.pid, guardianPid: child.guardianPid, containmentPid: child.containmentPid, phase: 'started' };
    await atomicJson(journalFile, journal);
    const deadline = Date.now() + timeoutMs;
    let health;
    while (Date.now() < deadline) {
      if (!child.alive()) throw Error('candidate_exited');
      try { health = await probe({ port, token, timeoutMs: Math.min(2000, Math.max(1, deadline - Date.now())) }); break; }
      catch { await delay(100); }
    }
    if (!health || health.pid !== child.pid || path.resolve(health.cwd) !== version.root) throw Error('candidate_health_timeout_or_identity');
    await checkpoint('healthy', { ...child, port });
    await verifyPrevious(previous);
    await resolveVersion(candidate);
    if (!child.alive()) throw Error('candidate_exited_before_promotion');
    if (!equal(await readJson(activeFile), previous.reference)) throw Error('selector_concurrent_change');
    journal.phase = 'promoting';
    await atomicJson(journalFile, journal);
    await checkpoint('promoting');
    await atomicJson(activeFile, candidate);
    await checkpoint('promoted');
    health = await probe({ port, token, timeoutMs: 3000 });
    if (health.pid !== child.pid) throw Error('post_promotion_identity');
    journal.phase = 'selected';
    await atomicJson(journalFile, journal);
    let checking = false;
    timer = setInterval(async () => {
      if (checking || completed) return;
      checking = true;
      try { const result = await probe({ port, token, timeoutMs: 2000 }); if (result.pid !== child.pid) throw Error('identity'); }
      catch {
        try { await rollback(); }
        catch { onRollback({ ok: false, status: 'rollback-incomplete', previousPid: previous.pid }); }
      }
      finally { checking = false; }
    }, 3000);
    return { candidatePid: child.pid, guardianPid: child.guardianPid, previousPid: previous.pid, health, rollback };
  } catch (error) {
    try { await rollback(); } catch (failure) { throw new AggregateError([error, failure], 'rollback_incomplete'); }
    throw error;
  }
}
