import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, symlink, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fork, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { atomicJson, digest, readJson, resolveVersion } from './runtime-version-store.mjs';
import { cutover, recover, startCandidate } from './runtime-version-transaction.mjs';
import { probe } from './runtime-mcp-probe.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Crash helper uses the same real controller, killed after the selector rename.
if (process.argv[2] === '--crash-helper') {
  const options = await readJson(process.argv[3]);
  options.previous.token = process.env.TEST_PREVIOUS_TOKEN;
  await cutover({ ...options, checkpoint: async phase => {
    if (phase === process.argv[4]) { setInterval(() => {}, 1000); process.send({ phase }); await new Promise(() => {}); }
  } });
} else {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'cmcp-version-'));
  const evidence = { schema: 1, node: process.version, platform: process.platform, candidateCommit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), tests: [], processes: [], ports: [] };
  const owned = [];
  const ports = [];
  async function port() {
    const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const value = server.address().port; await new Promise(resolve => server.close(resolve)); ports.push(value); return value;
  }
  async function files(directory, prefix = '') {
    const result = [];
    for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) result.push(...await files(directory, name));
      else result.push({ path: name, sha256: digest(await readFile(path.join(directory, name))) });
    }
    return result;
  }
  async function stage(name, entry = 'dist/index.js', extra) {
    const source = name === 'current' ? (process.env.RUNTIME_PREVIOUS_ROOT ?? root) : root;
    const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const directory = path.join(temp, name); await mkdir(directory);
    for (const item of ['dist', 'policy', 'package.json']) await cp(path.join(source, item), path.join(directory, item), { recursive: true });
    await symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'junction');
    if (extra) await writeFile(path.join(directory, entry), extra);
    const manifest = { schema: 1, commit, entry, files: [...await files(directory, 'dist'), ...await files(directory, 'policy'), { path: 'package.json', sha256: digest(await readFile(path.join(directory, 'package.json'))) }] };
    const manifestPath = path.join(directory, 'version.json'); await atomicJson(manifestPath, manifest);
    return { manifest: manifestPath, sha256: digest(await readFile(manifestPath)) };
  }
  async function test(name, action) {
    const start = Date.now(); await action();
    const journal = await readJson(path.join(temp, 'selector', 'transaction.json'));
    if (journal.candidatePid) assert.throws(() => process.kill(journal.candidatePid, 0), { code: 'ESRCH' });
    if (journal.guardianPid) assert.throws(() => process.kill(journal.guardianPid, 0), { code: 'ESRCH' });
    if (journal.containmentPid) assert.throws(() => process.kill(journal.containmentPid, 0), { code: 'ESRCH' });
    evidence.tests.push({ name, passed: true, durationMs: Date.now() - start, previousPid: journal.previousPid,
      candidatePid: journal.candidatePid, guardianPid: journal.guardianPid, phase: journal.phase, candidateAndGuardianStopped: true });
    console.log(`PASS ${name}`);
  }
  let active;
  try {
    const current = await stage('current');
    const candidate = await stage('candidate');
    evidence.manifests = { current, candidate };
    const oldPort = await port();
    const oldToken = 'isolated-regression-previous-token';
    const old = await startCandidate(await resolveVersion(current), { port: oldPort, token: oldToken, workspace: path.join(temp, 'old-workspace') }); owned.push(old);
    const previous = { reference: current, pid: old.pid, port: oldPort, token: oldToken };
    for (let i = 0; ; i++) { try { await probe(previous); break; } catch (e) { if (i > 60) throw e; await delay(250); } }
    evidence.processes.push({ role: 'previous', pid: old.pid, guardianPid: old.guardianPid, port: oldPort });
    const base = path.join(temp, 'selector'); await atomicJson(path.join(base, 'active.json'), current);
    async function options(reference = candidate) { return { base, previous, candidate: reference, port: await port(), workspace: path.join(temp, `workspace-${ports.length}`), timeoutMs: 4000 }; }
    await test('real-runtime-success-and-repeated-rollback', async () => {
      active = await cutover(await options());
      evidence.processes.push({ role: 'successful-candidate', pid: active.candidatePid, guardianPid: active.guardianPid });
      assert.deepEqual(await readJson(path.join(base, 'active.json')), candidate);
      assert.equal(active.health.initialize && active.health.toolsList && active.health.health, true);
      await active.rollback(); await active.rollback(); active = undefined;
      assert.deepEqual(await readJson(path.join(base, 'active.json')), current); assert.equal((await probe(previous)).pid, old.pid);
    });
    const startup = await stage('startup-failure', 'dist/fail.mjs', 'process.exit(23);');
    await test('startup-failure', async () => { await assert.rejects(cutover(await options(startup))); assert.deepEqual(await readJson(path.join(base, 'active.json')), current); });
    const unhealthy = await stage('health-failure', 'dist/unhealthy.mjs', `import http from 'node:http'; http.createServer((q,s)=>{s.writeHead(401);s.end();}).listen(Number(process.env.CONSOLE_MCP_PORT),'127.0.0.1');`);
    await test('health-failure-and-timeout', async () => { await assert.rejects(cutover(await options(unhealthy))); assert.deepEqual(await readJson(path.join(base, 'active.json')), current); });
    await test('candidate-process-termination', async () => {
      await assert.rejects(cutover({ ...await options(), checkpoint: async (phase, child) => { if (phase === 'healthy') { process.kill(child.pid, 'SIGKILL'); await delay(250); } } }));
      assert.equal((await probe(previous)).pid, old.pid);
    });
    await test('post-promotion-automatic-process-rollback', async () => {
      const startedAt = Date.now(), events = [];
      active = await cutover({ ...await options(), onRollback: event => events.push(event) });
      process.kill(active.candidatePid, 'SIGKILL');
      let restored = false;
      // The 3-second probe cadence plus bounded guardian/containment cleanup can
      // exceed eight seconds under load. Retain a finite full-cleanup deadline.
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) { await delay(100); if ((await readJson(path.join(base, 'transaction.json'))).phase === 'rolled-back') { restored = true; break; } }
      evidence.automaticRollbackMs = Date.now() - startedAt;
      assert.equal(restored, true, JSON.stringify({ elapsedMs: evidence.automaticRollbackMs, events }));
      await active.rollback(); active = undefined;
      assert.equal((await probe(previous)).pid, old.pid);
    });
    await test('concurrent-controller-rejected', async () => {
      active = await cutover(await options());
      await assert.rejects(cutover(await options()), /transaction_locked/);
      await active.rollback(); active = undefined;
    });
    if (process.platform === 'win32') for(const target of ['guardianPid','containmentPid']) await test(`abrupt-${target}-containment`, async () => {
      let killed;
      await assert.rejects(cutover({ ...await options(), checkpoint: async (phase, child) => {
        if(phase==='healthy'){killed=child.pid;process.kill(child[target],'SIGKILL');await delay(1500);}
      }}));
      assert.throws(()=>process.kill(killed,0),{code:'ESRCH'});
      assert.equal((await probe(previous)).pid,old.pid);
    });
    await test('rollback-health-gate-fails-closed-and-can-retry', async () => {
      let outcome;
      active = await cutover({ ...await options(), onRollback: result => { outcome = result; } });
      previous.token = 'intentionally-invalid-test-token';
      try {
        process.kill(active.candidatePid, 'SIGKILL');
        for (let i = 0; i < 150 && !outcome; i++) await delay(100);
        assert.equal(outcome?.status, 'rollback-incomplete');
        assert.deepEqual(await readJson(path.join(base, 'active.json')), candidate);
      } finally { previous.token = oldToken; }
      await active.rollback(); active = undefined;
      assert.deepEqual(await readJson(path.join(base, 'active.json')), current);
    });
    await test('promotion-failure', async () => {
      await assert.rejects(cutover({ ...await options(), checkpoint: async phase => { if (phase === 'promoting') throw Error('injected_promotion_failure'); } }));
      assert.deepEqual(await readJson(path.join(base, 'active.json')), current);
    });
    if (process.platform === 'win32') await test('windows-selector-rename-denied', async () => {
      let holder;
      try {
        await assert.rejects(cutover({ ...await options(), checkpoint: async phase => {
          if (phase !== 'promoting') return;
          holder = spawn('pwsh', ['-NoProfile', '-Command', '$h=[IO.File]::Open($env:SELECTOR_LOCK_TARGET,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); Write-Output ready; while($true){Start-Sleep -Seconds 1}'], {
            windowsHide: true, env: { ...process.env, SELECTOR_LOCK_TARGET: path.join(base, 'active.json') }, stdio: ['ignore','pipe','inherit'],
          });
          await Promise.race([once(holder.stdout, 'data'), once(holder, 'exit').then(() => { throw Error('file_lock_helper_failed'); })]);
        } }), error => ['EPERM','EACCES','EBUSY'].includes(error.code));
      } finally { if (holder && holder.exitCode === null) { holder.kill('SIGKILL'); await once(holder, 'exit'); } }
      assert.deepEqual(await readJson(path.join(base, 'active.json')), current);
      assert.equal((await readdir(base)).some(name => name.endsWith('.tmp')), false);
    });
    for (const phase of ['prepared', 'promoting', 'promoted']) await test(`controller-kill-at-${phase}-and-recovery`, async () => {
      const config = await options(); const configFile = path.join(temp, 'crash-config.json');
      await atomicJson(configFile, { ...config, previous: { ...previous, token: undefined } });
      const helper = fork(fileURLToPath(import.meta.url), ['--crash-helper', configFile, phase], { windowsHide: true, env: { ...process.env, TEST_PREVIOUS_TOKEN: oldToken }, stdio: ['ignore','ignore','inherit','ipc'] });
      try { await Promise.race([once(helper, 'message'), once(helper, 'exit').then(() => { throw Error('helper_exited_early'); }), delay(60000, undefined, { ref: false }).then(() => { throw Error('helper_timeout'); })]); }
      finally { helper.kill('SIGKILL'); await once(helper, 'exit'); }
      await recover(base, previous); await recover(base, previous);
      assert.deepEqual(await readJson(path.join(base, 'active.json')), current); assert.equal((await probe(previous)).pid, old.pid);
    });
    await test('artifact-tampering-rejected', async () => {
      await assert.rejects(resolveVersion({ ...candidate, sha256: '0'.repeat(64) }));
      const malicious = await stage('tamper'); await writeFile(path.join(path.dirname(malicious.manifest), 'dist/index.js'), 'process.exit(0)');
      await assert.rejects(cutover(await options(malicious)), /artifact_hash_mismatch/);
    });
    await test('protected-production-ports-rejected', async () => {
      for (const value of [3333,3334,3335,8791,8793,8795,8797,9222,9223,9224,9230]) await assert.rejects(cutover({ ...await options(), port: value }), /protected/);
      assert.deepEqual(await readJson(path.join(base, 'active.json')), current);
      assert.equal((await probe(previous)).pid, old.pid);
    });
    evidence.passed = true;
  } catch (error) { evidence.passed = false; evidence.failure = { message: error.message, stack: error.stack }; throw error; }
  finally {
    if (active) await active.rollback();
    for (const child of owned) await child.stop();
    for (const value of ports) {
      const server = net.createServer();
      try { server.listen(value, '127.0.0.1'); await once(server, 'listening'); evidence.ports.push({ port: value, released: true }); }
      finally { await new Promise(resolve => server.close(resolve)); }
    }
    evidence.cleanup = true;
    const output = process.env.RUNTIME_VERSION_EVIDENCE ?? path.join(root, 'var', 'runtime-version-evidence.json');
    await atomicJson(output, evidence);
    // This exact freshly-created temporary directory is the only removal target.
    assert.equal(path.dirname(temp), os.tmpdir()); assert.ok(path.basename(temp).startsWith('cmcp-version-'));
    await rm(temp, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
}
