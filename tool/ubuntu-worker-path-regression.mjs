import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Execute only the renderer, never the privileged installer or systemctl.
const script = readFileSync(new URL('../ops/ubuntu/script/install-systemd.sh', import.meta.url), 'utf8');
const renderer = script.match(/<<'UNIT_PY'\n([\s\S]*?)\nUNIT_PY/)[1];
const fixture = mkdtempSync(join(tmpdir(), 'worker-render-'));
const systemdFragment = value => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
try {
  const workspace = join(fixture, 'workspace with spaces % "quoted" \\ path');
  const parent = join(workspace, 'mcp');
  const root = join(parent, 'console-mcp');
  const nested = join(parent, 'Looping', 'Browsing');
  mkdirSync(root, { recursive: true });
  mkdirSync(nested, { recursive: true });
  const output = join(fixture, 'worker.service');
  const template = new URL('../ops/ubuntu/systemd/browser-mcp-worker.service', import.meta.url);
  for (const standalone of [false, true]) {
    if (standalone) mkdirSync(join(parent, 'browsing'));
    const result = spawnSync('python3', ['-c', renderer, template.pathname, output, root, workspace], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const rendered = readFileSync(output, 'utf8');
    const browsing = standalone ? join(parent, 'browsing') : nested;
    assert.ok(rendered.includes(`ExecStart=/usr/bin/node "${systemdFragment(browsing)}/playwright-worker/src/worker.js"`));
    assert.ok(rendered.includes(`BindReadOnlyPaths="${systemdFragment(workspace)}/var/artifacts/uploads"`));
    assert.ok(rendered.includes(`NoExecPaths="${systemdFragment(workspace)}/var/artifacts/uploads"`));
    assert.match(rendered, /NoNewPrivileges=true/);
    assert.match(rendered, /ProtectSystem=strict/);
    assert.doesNotMatch(rendered, /\/home\/alex/);
    assert.doesNotMatch(rendered, /@@[A-Z_]+@@/);
  }
  console.log('Ubuntu worker renderer: PASS (escaped special paths, nested and standalone precedence, portable roots, hardening)');
} finally { rmSync(fixture, { recursive: true, force: true }); }
