import assert from "node:assert/strict";
import fs from "node:fs";
const root=new URL("../",import.meta.url);
const manifest=JSON.parse(fs.readFileSync(new URL("policy/infrastructure-diagnostics-integration-draft.json",root),"utf8"));
const registration=fs.readFileSync(new URL("src/tool/infrastructure-diagnostics-registration-draft.ts",root),"utf8");
const dispatch=fs.readFileSync(new URL("src/tool/infrastructure-dispatch-draft.ts",root),"utf8");
const schemas=fs.readFileSync(new URL("src/tool/infrastructure-input-contract.ts",root),"utf8");
assert.equal(manifest.schemaVersion,1);
assert.equal(manifest.status,"staged-not-admitted");
assert.equal(manifest.runtimeRegistration,false);
assert.equal(manifest.operations.length,20);
assert.equal(new Set(manifest.operations.map(o=>o.operation)).size,20);
assert.equal(new Set(manifest.operations.map(o=>o.toolName)).size,20);
for(const row of manifest.operations){
 assert.equal(row.risk,"read_");
 assert.equal(row.linux,"draft-implemented");
 assert.equal(row.toolName.startsWith("read_."),true);
 assert.ok(registration.includes('server.registerTool("'+row.toolName+'"'),row.toolName+" missing registration");
 assert.ok(dispatch.includes('"'+row.operation+'":'),row.operation+" missing dispatch");
 assert.ok(schemas.includes('"'+row.operation+'":'),row.operation+" missing schema");
}
assert.equal(manifest.operations.filter(o=>o.windows==="draft-implemented").length,12);
assert.ok(manifest.verification.required.includes("npm run build"));
console.log("infrastructure integration manifest contract: PASS");
