import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Execute only the renderer, never the privileged installer or systemctl.
const script = readFileSync(new URL('../ops/ubuntu/script/install-systemd.sh', import.meta.url), 'utf8');
const renderer = script.match(/<<'UNIT_PY'\n([\s\S]*?)\nUNIT_PY/)[1];
const fixture = mkdtempSync(join(tmpdir(), 'worker-render-'));
try {
  const parent = join(fixture, 'workspace with spaces', 'mcp');
  const root = join(parent, 'console-mcp');
  const nested = join(parent, 'Looping', 'Browsing');
  mkdirSync(root, { recursive: true });
  mkdirSync(nested, { recursive: true });
  const output = join(fixture, 'worker.service');
  const template = new URL('../ops/ubuntu/systemd/browser-mcp-worker.service', import.meta.url);
  for (const standalone of [false, true]) {
    if (standalone) mkdirSync(join(parent, 'browsing'));
    const result = spawnSync('python3', ['-c', renderer, template.pathname, output, root, fixture], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const rendered = readFileSync(output, 'utf8');
    assert.ok(rendered.includes(`${standalone ? join(parent, 'browsing') : nested}/playwright-worker/src/worker.js`));
    assert.match(rendered, /NoNewPrivileges=true/);
    assert.match(rendered, /ProtectSystem=strict/);
    assert.doesNotMatch(rendered, /\/home\/alex/);
  }
  console.log('Ubuntu worker renderer: PASS (nested, standalone precedence, portable roots, hardening)');
} finally { rmSync(fixture, { recursive: true, force: true }); }
