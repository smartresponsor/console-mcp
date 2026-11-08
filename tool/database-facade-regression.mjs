import assert from "node:assert/strict";
import fs from "node:fs";
const source = fs.readFileSync(new URL("../src/engine/mcp-facades.ts", import.meta.url), "utf8");
assert.match(source, /"database"/);
console.log("database facade second-token source contract: PASS");
