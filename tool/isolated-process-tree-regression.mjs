import assert from "node:assert/strict";
import { runIsolatedTestStage } from "../dist/tool/isolated-test-stage.js";

// Stage launches a Node process that itself launches a child Node process;
// timeout must terminate the entire tree, rather than only the npm/node parent.
const source = [
  'const {spawn} = require("node:child_process");',
  'spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {stdio:"inherit"});',
  'setInterval(()=>{},1000);',
].join("");
const started = Date.now();
const result = await runIsolatedTestStage(process.cwd(), process.execPath, ["-e", source], 1200);
assert.equal(result.ok, false);
assert.equal(result.timedOut, true);
assert.ok(Date.now() - started < 15000, "process-tree termination must not hang");
console.log("PASS isolated process-tree timeout regression");
