import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const source = fs.readFileSync(path.join(root, "src", "engine", "engine-cycle.ts"), "utf8");

assert.match(source, /const hasTarget = typeof task\.target_id === "string"/);
assert.match(source, /if \(typeof task\.assistant_hash === "string" && typeof task\.assistant_length === "number"\)/);
assert.match(source, /if \(typeof task\.decision_status !== "string"\) return "gateway_decision"/);
assert.match(source, /if \(typeof task\.reply_back_hash !== "string" \|\| typeof task\.reply_back_length !== "number"\) return hasTarget \? "reply_draft" : "chat_bind"/);
assert.match(source, /if \(!hasTarget\) return "chat_bind"/);
assert.doesNotMatch(source, /if \(typeof task\.target_id !== "string"\) return "chat_bind";\s*if \(typeof task\.composer_ready_at/);

console.log(JSON.stringify({ ok: true, status: "ENGINE_CYCLE_STAGE_ROUTING_REGRESSION_GREEN" }));
