import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const admission = JSON.parse(fs.readFileSync(new URL("../policy/console-tool-admission.json", import.meta.url), "utf8"));
const names = [
  "read_.release.runtime.status",
  "read_.release.transaction.status",
  "write.release.transaction.prepare",
  "write.release.transaction.validate",
  "write.release.transaction.activate",
  "write.release.transaction.rollback",
];
for (const name of names) {
  const declaration = admission.declarations.find((entry) => entry.name === name);
  assert.ok(declaration, `missing admission: ${name}`);
  assert.ok(declaration.consumers.includes("chatgpt"), `not admitted to ChatGPT: ${name}`);
  assert.notEqual(declaration.lifecycle, "retired");
}
assert.match(source, /const releaseFacadeEndpoint = /);
assert.match(source, /consumer === "chatgpt" && url\.pathname === releaseFacadeEndpoint/);
assert.match(source, /authorizeRequest\(req, authConfig, policy\.transcriptDir\)/);
assert.match(source, /releaseFacadeRequest \? releaseFacadeProjection : undefined/);
assert.match(source, /releaseFacadeRequest \? releaseFacadeProjection : consumerProjections\[consumer\]/);
assert.match(source, /projectionOverride \?\? consumerProjections\[consumer\]/);
console.log("release facade source and admission contract: PASS");
