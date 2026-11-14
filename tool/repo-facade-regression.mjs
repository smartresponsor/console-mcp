import assert from "node:assert/strict";
import fs from "node:fs";
const source = fs.readFileSync(new URL("../src/engine/mcp-facades.ts", import.meta.url), "utf8");
assert.match(source, /CHATGPT_FACADE_GROUPS = \["repo"\]/);
assert.doesNotMatch(source, /"runtime"|"browser"|"database"|"window"|"archive"|"transport"|"network"|"file"/);
console.log("repo facade single-group source contract: PASS");
