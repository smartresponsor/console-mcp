import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const guard=readFileSync(new URL("../src/service/visible-browser-tools.ts",import.meta.url),"utf8");
const bridge=readFileSync(new URL("../src/tool/web-domain-bridge.ts",import.meta.url),"utf8");
for(const op of ["write.web.form.proposal.preview","write.web.form.fill","write.web.form.review.snapshot","write.web.form.submit"]){
  assert.ok(guard.includes('name === "'+op+'"'),"exact-target guard missing "+op);
}
assert.match(guard,/name === "write\.web\.form\.proposal\.preview"\)\) \? 9224/);
assert.ok(guard.includes('name.startsWith("write.web.form.")'),"verified form operations must preserve target binding");
assert.ok(bridge.includes('consoleName === "write.web.form.proposal.preview"'),"preview must choose visible worker");
assert.ok(bridge.includes('consoleName.startsWith("write.web.form.") && typeof rawInput.expectedTargetId === "string"'),"target-bound form commands must choose visible worker");
console.log("Web form browser-session source contract: PASS");
