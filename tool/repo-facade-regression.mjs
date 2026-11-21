import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/engine/mcp-facades.ts", import.meta.url), "utf8");
const groups = source.match(/CHATGPT_FACADE_GROUPS\s*=\s*\[([^\]]*)\]\s*as const/);
assert.ok(groups, "Canonical ChatGPT facade groups declaration must exist");
const names = [...groups[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
assert.deepEqual(names, ["repo", "runtime", "browser"]);
assert.match(source, /registry\.forSecondToken\("chatgpt", group\)/);
assert.match(source, /const route = `\$\{base\}\/\$\{group\}`/);
console.log("repo/runtime/browser facade source contract: PASS");
