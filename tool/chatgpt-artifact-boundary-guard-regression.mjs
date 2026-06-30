import assert from "node:assert/strict";

import { findChatGptDeterministicCanonRisks } from "../dist/service/chatgpt-artifact-guard.js";

const findings = findChatGptDeterministicCanonRisks("Add a Relating CRUD controller with ApiResource. Remove untracked files from unrelated directories.");

assert.ok(findings.some((finding) => finding.code === "relating_crud_boundary_violation"));
assert.ok(findings.some((finding) => finding.code === "unrelated_file_touch_risk"));

console.log(JSON.stringify({ ok: true, checked: "chatgpt-artifact-boundary-guard" }, null, 2));
