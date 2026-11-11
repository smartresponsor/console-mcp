import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BROWSER_FACADE_TOOL_NAMES, browserFacadeToolNames } from '../dist/engine/browser-facade-tools.js';
const catalog = new Set([...readFileSync(new URL('../src/tool/catalog.ts', import.meta.url), 'utf8')
  .matchAll(/"((?:read_|write)\.web\.[^"]+)"/g)].map(match => match[1]));
const policy = JSON.parse(readFileSync(new URL('../policy/console-tool-admission.json', import.meta.url), 'utf8'));
const admitted = new Set(policy.declarations.filter(entry => entry.lifecycle === 'admitted' &&
  entry.consumers.includes('chatgpt')).map(entry => entry.name));
const projection = browserFacadeToolNames(catalog, admitted);
assert.equal(projection.size, BROWSER_FACADE_TOOL_NAMES.length);
assert.ok(projection.size < 256, 'Browser facade should not hit client-side discovery cap');
assert.deepEqual([...projection].sort(), [...catalog].sort(), 'Browser facade should expose complete canonical Web family');
assert.ok(projection.has('read_.web.session.lease.status'));
for (const name of BROWSER_FACADE_TOOL_NAMES) {
  assert.ok(name.startsWith('read_.web.') || name.startsWith('write.web.'), name);
  assert.ok(admitted.has(name), `Not admitted to ChatGPT: ${name}`);
  assert.throws(() => browserFacadeToolNames(new Set([...catalog].filter(x => x !== name)), admitted), /unregistered or unadmitted/);
  assert.throws(() => browserFacadeToolNames(catalog, new Set([...admitted].filter(x => x !== name))), /unregistered or unadmitted/);
}
assert.throws(() => browserFacadeToolNames(new Set(), new Set()), /unregistered or unadmitted/);
console.log(`BROWSER_FACADE_PROJECTION_GREEN: ${projection.size} complete admitted Web commands, fail-closed omissions`);
