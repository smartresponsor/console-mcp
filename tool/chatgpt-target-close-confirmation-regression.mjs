import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const source = fs.readFileSync(path.join(root, "src", "service", "browser-session-executor.ts"), "utf8");

assert.match(source, /const closeVerificationMs = Math\.min\(Math\.max\(timeoutMs, 1500\), 5000\)/);
assert.match(source, /const closeDeadline = Date\.now\(\) \+ closeVerificationMs/);
assert.match(source, /do \{/);
assert.match(source, /remaining = await findDevToolsTargetById/);
assert.match(source, /await delay\(250\)/);
assert.match(source, /while \(Date\.now\(\) <= closeDeadline\)/);
assert.match(source, /close_verification_ms: closeVerificationMs/);

console.log(JSON.stringify({ ok: true, status: "CHATGPT_TARGET_CLOSE_CONFIRMATION_REGRESSION_GREEN" }));
