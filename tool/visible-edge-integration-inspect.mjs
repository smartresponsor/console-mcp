import { inspectVisibleTarget } from '../dist/service/visible-browser-session.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const config = {};
for (const file of ['/etc/console-mcp/console-mcp.env', '/etc/console-mcp/browsing.env']) {
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = line.match(/^([A-Z_][A-Z_0-9]*)=(.*)$/);
      if (match) config[match[1]] = match[2].trim().replace(/^([\"'])(.*)\1$/, '$2');
    }
  } catch {}
}
const token = (process.env.BROWSER_MCP_BROWSER_WORKER_TOKEN ?? config.BROWSER_MCP_BROWSER_WORKER_TOKEN)?.trim();
if (!token) throw new Error('Worker authorization is unavailable; no requests sent');
const request = async (port, route, body = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
  });
  return { http: response.status, body: await response.json() };
};
const taskRoot = '/var/lib/console-mcp/run/engine/task';
const taskHashes = () => {
  try { return readdirSync(taskRoot).filter(n => n.endsWith('.json')).sort().map(file => ({ file, sha256: createHash('sha256').update(readFileSync(`${taskRoot}/${file}`)).digest('hex') })); } catch { return null; }
};
const selectedTargetId = process.argv[2] ?? null;
if (selectedTargetId && !/^[A-Fa-f0-9]{32}$/.test(selectedTargetId)) throw new Error('Invalid explicit target ID');
const before = taskHashes();
const report = { at: new Date().toISOString(), workers: [], submissionsAttempted: false };
for (const [worker, cdp] of [[8791, 9223], [8793, 9224]]) {
  const result = await request(worker, '/browser-cdp-targets');
  const direct = await (await fetch(`http://127.0.0.1:${cdp}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  const targets = result.body.targets ?? [];
  const ids = targets.map(t => t.id ?? t.targetId).sort();
  const expected = direct.map(t => t.id).sort();
  const matched = result.http === 200 && JSON.stringify(ids) === JSON.stringify(expected) && ids.length > 0;
  report.workers.push({ worker, cdp, authorizedHttp: result.http, matched, targetCount: ids.length,
    targetIdentityHash: createHash('sha256').update(JSON.stringify(ids)).digest('hex') });
  if (worker === 8793 && matched) {
    const candidates = targets.filter(t => String(t.url).startsWith('https://jobs.ashbyhq.com/gc-ai/'));
    report.gcAiCandidateCount = candidates.length;
    report.gcAiCandidates = candidates.map(t => ({ targetId: t.id ?? t.targetId, url: t.url, title: t.title }));
    const eligible = [];
    report.visibility = [];
    for (const candidate of candidates) {
      const targetId = candidate.id ?? candidate.targetId;
      const result = await inspectVisibleTarget({ port: cdp, targetId });
      report.visibility.push({ targetId, ok: result.ok, reason: result.reason, status: result.status });
      if (result.ok) eligible.push(candidate);
    }
    const selected = selectedTargetId ? eligible.filter(t => (t.id ?? t.targetId) === selectedTargetId) : eligible;
    if (selected.length === 1 && (selectedTargetId || eligible.length === 1)) {
      const targetId = selected[0].id ?? selected[0].targetId;
      report.bind = await request(worker, '/browser-bind', { targetId });
      if (report.bind.http === 200 && report.bind.body.ok === true) {
        const captured = await request(worker, '/page-capture', { targetId, screenshot: true });
        report.capture = { http: captured.http, body: { ok: captured.body.ok === true, status: captured.body.status ?? null, fields: Object.keys(captured.body), screenshotPresent: JSON.stringify(captured.body).includes('base64') || JSON.stringify(captured.body).includes('screenshot') } };
      }
    }
  }
}
const bearer = (process.env.CONSOLE_MCP_BEARER_TOKEN ?? config.CONSOLE_MCP_BEARER_TOKEN)?.trim();
if (bearer) {
  const client = new Client({ name: 'visible-edge-infrastructure-inspect', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3334/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } }
    }));
    const { tools } = await client.listTools();
    report.liveSchemas = tools.filter(t => ['write.web.browser.bind', 'read_.web.page.capture', 'read_.web.browser.targets'].includes(t.name))
      .map(t => ({ name: t.name, browserSession: t.inputSchema.properties?.browserSession ?? null }));
  } finally { await client.close(); }
} else report.liveSchemaBlocker = 'Service bearer credential unavailable';
report.taskFilesUnchanged = before !== null && JSON.stringify(before) === JSON.stringify(taskHashes());
report.taskFileCount = before?.length ?? null;
report.integrationReady = report.workers.every(w => w.matched) && report.liveSchemas?.every(t => t.browserSession) && report.bind?.body.ok === true && report.capture?.body.ok === true;
console.log(JSON.stringify(report));
