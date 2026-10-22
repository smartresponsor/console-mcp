// Static source-contract regression; run against staged feature build sources.
import assert from "node:assert/strict";
import fs from "node:fs";
const registration=fs.readFileSync(new URL("../src/tool/infrastructure-diagnostics-registration-draft.ts",import.meta.url),"utf8");
const dispatch=fs.readFileSync(new URL("../src/tool/infrastructure-dispatch-draft.ts",import.meta.url),"utf8");
const names=[...registration.matchAll(/server\.registerTool\("([^"]+)"/g)].map(x=>x[1]);
const operations=[...registration.matchAll(/dispatchLocalInfrastructure\("([^"]+)"/g)].map(x=>x[1]);
assert.equal(names.length,20);
assert.equal(new Set(names).size,20);
assert.equal(operations.length,20);
assert.equal(new Set(operations).size,20);
assert.ok(names.every(name=>name.startsWith("read_.network.")||name.startsWith("read_.system.")));
assert.ok(names.includes("read_.network.firewall.chain.list"));
assert.equal(names.includes("read_.network.firewall.rule.list"),false);
assert.equal(registration.includes('from "./infrastructure-dispatch-draft.js"'),true);
assert.equal(dispatch.includes("const linux:Partial<Record<InfraOperation,Handler>>"),true);
assert.equal(dispatch.includes("const windows:Partial<Record<InfraOperation,Handler>>"),true);
console.log("staged infrastructure registry source contract: PASS");
