import assert from "node:assert/strict";
import fs from "node:fs";
assert.match(fs.readFileSync(new URL("../src/engine/mcp-facades.ts", import.meta.url), "utf8"), /"window"/);
console.log("window facade second-token source contract: PASS");
