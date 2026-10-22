import assert from "node:assert/strict";
import fs from "node:fs";
const source=fs.readFileSync(new URL("../src/tool/infrastructure-dispatch-draft.ts",import.meta.url),"utf8");
assert.match(source,/status==="complete"\|\|status==="partial"/);
assert.match(source,/normalizeInfraData\(operation,selected,raw\.data\) : \{\}/);
assert.match(source,/finalizeInfrastructureObservation\(normalizedObservation/);
console.log("RC1 failed-observation isolation source contract: PASS");
