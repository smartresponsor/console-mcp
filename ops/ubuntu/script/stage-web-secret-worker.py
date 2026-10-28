#!/usr/bin/env python3
"""Create an offline worker candidate; never edit the source or restart anything."""
import argparse
import hashlib
import json
import pathlib
import shutil

p = argparse.ArgumentParser()
p.add_argument('--source', required=True, type=pathlib.Path)
p.add_argument('--destination', required=True, type=pathlib.Path)
p.add_argument('--console-root', type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[3])
a = p.parse_args()
source = a.source.resolve()
dest = a.destination.resolve()
if dest.exists() or dest == source or source in dest.parents:
    raise SystemExit('Destination must be a new isolated directory outside source')
worker_bytes = (source / 'src/worker.js').read_bytes()
if hashlib.sha256(worker_bytes).hexdigest() != 'c602980a5ef485dc040f8373fa1e9725355764aa59f7e4b582bc52a005b21d13':
    raise SystemExit('Unsupported worker revision: security review required')
source_digest = hashlib.sha256(b''.join(
    item.name.encode() + b'\0' + item.read_bytes() + b'\0'
    for item in sorted((source / 'src').glob('*.js')))).hexdigest()
if source_digest != '3223af6f744af38d871afdeda8b19d92f7a3cf9e4dc6e111a0eeecb957fb2aca':
    raise SystemExit('Unsupported worker dependencies: security review required')
text = worker_bytes.decode()
# Relocation must use the selected Console build, never implicitly the live one.
for module in ['visible-browser-session', 'grants-browser-session']:
    built = a.console_root.resolve() / 'dist/service' / (module + '.js')
    if not built.is_file():
        raise SystemExit('Build the selected Console checkout before staging')
    text = text.replace("'../../../../console-mcp/dist/service/" + module + ".js'", json.dumps(built.as_uri()))

anchor = "app.post('/propose', async (req, res) => {"
quarantine_anchor = 'const visibleRequest = new AsyncLocalStorage();'
if text.count(anchor) != 1 or text.count(quarantine_anchor) != 1:
    raise SystemExit('Unsupported worker: review integration anchors')
# Existing authentication, visible session gate, lease and post-verification remain.
imports = "import { installWebSecretFill, secretRoot } from './web-secret-fill.mjs';\nimport { existsSync as secretExists } from 'node:fs';\nimport { resolve as secretResolve } from 'node:path';\n"
quarantine = """
app.use((req, res, next) => {
  try {
    if (secretExists(secretResolve(secretRoot(), 'quarantine'))) {
      return res.status(409).json({ ok: false, status: 'WEB_SECRET_LOCAL_CLEANUP_REQUIRED', automatic_retry_allowed: false });
    }
  } catch { return res.status(409).json({ ok: false, status: 'WEB_SECRET_CONFIGURATION_REQUIRED' }); }
  // Outer response filter executes after canonical post-operation verification.
  if (req.path === '/secret-fill') {
    const send = res.json.bind(res);
    res.json = body => send({ ok: body.ok === true,
      status: body.ok === true ? 'WEB_SECRET_FILL_VERIFIED' : 'WEB_SECRET_FILL_DENIED',
      outcome_unknown: body.ok !== true, local_cleanup_required: true, automatic_retry_allowed: false });
  }
  next();
});
"""
registration = """
installWebSecretFill(app, { getPolicy, ensurePage, ensureNotChallenge, capturePageArtifact,
  visibleRequest, resolveRequestedFieldLocator, createApprovalReceipt, consumeApprovalReceipt,
  quota(commit) {
    const policy = getPolicy();
    if (formFillCount >= policy.maxFormFills || fieldWriteCount + 1 > policy.maxFieldWrites)
      throw new Error('WEB_SECRET_FILL_DENIED');
    if (commit) { formFillCount += 1; fieldWriteCount += 1; }
  }
});
"""
text = imports + text.replace(quarantine_anchor, quarantine + quarantine_anchor).replace(anchor, registration + anchor)
shutil.copytree(source / 'src', dest / 'src')
shutil.copy2(source / 'package.json', dest / 'package.json')
(dest / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
shutil.copy2(pathlib.Path(__file__).resolve().parents[1] / 'runtime/web-secret-fill.mjs', dest / 'src/web-secret-fill.mjs')
(dest / 'src/worker.js').write_text(text)
print('Offline candidate staged; production unchanged')
