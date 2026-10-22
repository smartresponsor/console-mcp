import assert from "node:assert/strict";
import fs from "node:fs";
import { classifyCommandFailure } from "../dist/tool/infrastructure-failure-contract.js";

// Static wiring assertions complement later runtime tests with mocked OS commands.
for (const name of [
 "infrastructure-network-observations",
 "infrastructure-host-observations",
 "infrastructure-security-observations",
 "infrastructure-system-diagnostics",
 "infrastructure-windows-network",
 "infrastructure-windows-observations",
]) {
 const source=fs.readFileSync(new URL(`../src/tool/${name}.ts`,import.meta.url),"utf8");
 assert.match(source,/import \{ classifyCommandFailure \}/);
 assert.match(source,/classifyCommandFailure\(/);
 assert.match(source,/permission_denied/);
 assert.match(source,/timeout/);
}
for(const [stderr,expected] of [
 ["Operation not permitted","permission_denied"],
 ["Access is denied","permission_denied"],
 ["No such process","no_data"],
 ["executable not installed","unavailable"],
]){
 assert.equal(classifyCommandFailure({exitCode:1,stderr}).status,expected);
}
console.log("infrastructure command failure wiring fixtures: PASS");
