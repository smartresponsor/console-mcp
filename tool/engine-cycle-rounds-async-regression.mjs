import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const engineSource = fs.readFileSync(path.join(root, "src", "tool", "engine.ts"), "utf8");
const runnerSource = fs.readFileSync(path.join(root, "src", "tool", "engine-cycle-rounds-async-runner.ts"), "utf8");
const catalogSource = fs.readFileSync(path.join(root, "src", "tool", "catalog.ts"), "utf8");
const policy = JSON.parse(fs.readFileSync(path.join(root, "policy", "console-tool-catalog-engine.json"), "utf8"));

for (const name of [
  "console.write.engine.cycle.rounds.start",
  "console.read_.engine.cycle.rounds.status",
  "console.read_.engine.cycle.rounds.output",
  "console.write.engine.cycle.rounds.stop",
]) {
  assert.equal(engineSource.includes(name), true, `engine async lifecycle registration missing: ${name}`);
  assert.equal(catalogSource.includes(name), true, `catalog missing engine async lifecycle tool: ${name}`);
  assert.equal(policy.tools.some((item) => item.canonicalName === name), true, `policy missing engine async lifecycle tool: ${name}`);
}

assert.equal(engineSource.includes("startAsyncCommandRun({"), true, "engine cycle async start must reuse AsyncCommandRun");
assert.equal(runnerSource.includes("runEngineCycleRounds(paths"), true, "async worker must reuse shared runEngineCycleRounds");
assert.equal(runnerSource.includes("createEnginePaths(baseDir)"), true, "async worker must use shared engine paths");
assert.equal(engineSource.includes('status_tool: "console.read_.engine.cycle.rounds.status"'), true, "start result must advertise status tool");
assert.equal(engineSource.includes('output_tool: "console.read_.engine.cycle.rounds.output"'), true, "start result must advertise output tool");
assert.equal(engineSource.includes('stop_tool: "console.write.engine.cycle.rounds.stop"'), true, "start result must advertise stop tool");

console.log("Engine cycle rounds async lifecycle regression passed.");
