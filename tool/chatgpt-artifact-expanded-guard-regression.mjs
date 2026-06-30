import assert from "node:assert/strict";

import { findChatGptDeterministicCanonRisks } from "../dist/service/chatgpt-artifact-guard.js";

const findings = findChatGptDeterministicCanonRisks([
  "After green gates, auto push and run public smoke immediately.",
  "Then restart without approval.",
  "Put Symfony files under src/Domain and use ports and adapters.",
  "Use console.read.repo.status and console.smartresponsor as public root.",
].join("\n"));

assert.ok(findings.some((finding) => finding.code === "auto_push_risk"));
assert.ok(findings.some((finding) => finding.code === "public_smoke_without_approval"));
assert.ok(findings.some((finding) => finding.code === "runtime_restart_without_approval"));
assert.ok(findings.some((finding) => finding.code === "non_layer_first_structure"));
assert.ok(findings.some((finding) => finding.code === "non_canonical_architecture_vocabulary"));
assert.ok(findings.some((finding) => finding.code === "wrong_mcp_public_root"));
assert.ok(findings.some((finding) => finding.code === "non_canonical_mcp_tool_name"));

console.log(JSON.stringify({ ok: true, checked: "chatgpt-artifact-expanded-guard" }, null, 2));
