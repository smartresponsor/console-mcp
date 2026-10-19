import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CanonicalToolRegistry } from '../dist/engine/canonical-tool-registry.js';
import { getToolAdmissionDeclaration } from '../dist/engine/tool-admission.js';
import { consoleToolNames } from '../dist/tool/catalog.js';
import { registerIsolatedDatabaseTools } from '../dist/tool/database-isolation.js';

const names = ['read_.database.inspect', 'write.database.create', 'write.database.prepare', 'write.database.release'];
const compatibilityNames = ['read_.database.isolated.inspect', 'write.database.isolated.create', 'write.database.isolated.prepare', 'write.database.isolated.release'];
const allNames = [...names, ...compatibilityNames];
// Exercise the production recording sink: a plain registerTool mock missed this startup crash.
const registry = CanonicalToolRegistry.build(server => registerIsolatedDatabaseTools(server, {}, {}));
const policies = JSON.parse(await readFile(new URL('../policy/console-tool-catalog-read-infra.json', import.meta.url), 'utf8')).tools;
for (const consumer of ['chatgpt', 'codex', 'runner']) {
  assert.deepEqual([...registry.forConsumer(consumer).toolNames].sort(), [...allNames].sort());
}
const configs = new Map();
registerIsolatedDatabaseTools({ registerTool(name, config) { configs.set(name, config); } }, {}, {
  mode: 'oauth', readScope: 'fixture.read', writeScope: 'fixture.write',
});
assert.deepEqual([...configs.keys()].sort(), [...allNames].sort());
for (const name of names) {
  assert.ok(consoleToolNames.includes(name), `Missing catalog entry: ${name}`);
  const declaration = getToolAdmissionDeclaration(name);
  const write = name.startsWith('write.');
  assert.equal(declaration.risk, write ? 'write' : 'read_');
  assert.equal(declaration.lifecycle, 'admitted');
  assert.equal(declaration.source, 'policy/console-tool-catalog-read-infra.json');
  assert.equal(configs.get(name).annotations.readOnlyHint, !write);
  assert.deepEqual(configs.get(name)._meta.securitySchemes[0].scopes, [write ? 'fixture.write' : 'fixture.read']);
  if (write) {
    const policy = policies.find(item => item.canonicalName === name);
    assert.equal(policy.mutatesDatabase, true);
    assert.equal(policy.requiresEvidence, true);
  }
}
assert.throws(() => getToolAdmissionDeclaration('write.database.unadmitted'), /Console tool is not admitted/);
console.log('Database admission PASS: all four production registrations, catalogs, consumer projections, OAuth scopes, mutation/evidence flags and unknown-tool rejection');
