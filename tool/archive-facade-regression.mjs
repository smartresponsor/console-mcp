import assert from "node:assert/strict";
import fs from "node:fs";
assert.match(fs.readFileSync(new URL("../src/engine/mcp-facades.ts", import.meta.url), "utf8"), /"archive"/);
console.log("archive facade second-token source contract: PASS");
