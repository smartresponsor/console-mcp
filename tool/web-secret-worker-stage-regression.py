#!/usr/bin/env python3
"""Offline staging must preserve gates and reject unsupported source trees."""
import argparse
from pathlib import Path
import shutil
import subprocess
import tempfile

p = argparse.ArgumentParser()
p.add_argument('--source', required=True, type=Path)
a = p.parse_args()
root = Path(__file__).resolve().parents[1]
script = root / 'ops/ubuntu/script/stage-web-secret-worker.py'
with tempfile.TemporaryDirectory(prefix='secret-stage-') as temporary:
    temporary = Path(temporary)
    command = ['python3', str(script), '--source', str(a.source),
               '--destination', str(temporary / 'candidate')]
    assert subprocess.run(command, capture_output=True).returncode == 0
    assert subprocess.run(command, capture_output=True).returncode != 0
    text = (temporary / 'candidate/src/worker.js').read_text()
    assert text.index('authorizeBrowserWorkerRequest(req, res)') < text.index('secretQuarantined(secretRoot')
    assert text.index('secretQuarantined(secretRoot') < text.index('const visibleRequest =') < text.index('installWebSecretFill(app,')
    assert (root / 'dist/service/visible-browser-session.js').as_uri() in text
    assert subprocess.run(['node', '--check', str(temporary / 'candidate/src/worker.js')], capture_output=True).returncode == 0
    middleware_test = r"""
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const text = readFileSync(process.argv[1], 'utf8');
const start = text.indexOf('app.use(async (req, res, next) => {\n  try {\n    if (await secretQuarantined');
const code = text.slice(start, text.indexOf('const visibleRequest =', start));
let middleware, quarantined = false, broken = false;
vm.runInNewContext(code, { app: { use: fn => { middleware = fn; } },
  secretQuarantined: async () => { if (broken) throw Error('private'); return quarantined; },
  secretRoot: () => { if (broken) throw Error('private'); return '/secret'; } });
async function run(body) {
  let result, next = false;
  const res = { status() { return this; }, json(value) { result = value; return this; } };
  await middleware({ path: '/secret-fill' }, res, () => { next = true; });
  if (next) res.json(body);
  assert.equal(JSON.stringify(result).includes('synthetic-private-value'), false);
  return result;
}
assert.equal((await run({ ok: true, evidence: 'synthetic-private-value' })).status, 'WEB_SECRET_FILL_VERIFIED');
assert.equal((await run({ ok: false, error: 'synthetic-private-value', visible_session: 'synthetic-private-value' })).status, 'WEB_SECRET_FILL_DENIED');
quarantined = true;
assert.equal((await run({ ok: true })).status, 'WEB_SECRET_LOCAL_CLEANUP_REQUIRED');
quarantined = false; broken = true;
assert.equal((await run({ ok: true })).status, 'WEB_SECRET_CONFIGURATION_REQUIRED');
"""
    assert subprocess.run(['node', '--input-type=module', '-e', middleware_test,
                           str(temporary / 'candidate/src/worker.js')], capture_output=True).returncode == 0
    quota_test = r"""
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const text = readFileSync(process.argv[1], 'utf8');
const start = text.indexOf('installWebSecretFill(app, {');
const code = text.slice(start, text.indexOf("app.post('/propose'", start));
let hooks;
const context = { app: {}, installWebSecretFill: (_app, deps) => { hooks = deps; },
  getPolicy: () => ({ maxFormFills: 1, maxFieldWrites: 2 }), formFillCount: 0, fieldWriteCount: 0 };
for (const key of ['ensurePage','ensureNotChallenge','capturePageArtifact','visibleRequest',
  'resolveRequestedFieldLocator','createApprovalReceipt','consumeApprovalReceipt']) context[key] = () => {};
vm.runInNewContext(code, context);
hooks.quota(false, 2);
assert.equal(context.fieldWriteCount, 0);
hooks.quota(true, 2);
assert.equal(context.formFillCount, 1);
assert.equal(context.fieldWriteCount, 2);
assert.throws(() => hooks.quota(false, 1));
"""
    assert subprocess.run(['node', '--input-type=module', '-e', quota_test,
                           str(temporary / 'candidate/src/worker.js')], capture_output=True).returncode == 0
    shutil.copytree(a.source / 'src', temporary / 'changed/src')
    (temporary / 'changed/src/approval-receipt.js').write_text('// unsupported\n')
    result = subprocess.run(['python3', str(script), '--source', str(temporary / 'changed'),
                             '--destination', str(temporary / 'bad')], capture_output=True)
    assert result.returncode != 0 and not (temporary / 'bad').exists()
print('Worker staging: PASS (gate order, pair quotas, response redaction, quarantine, isolated imports and drift)')
