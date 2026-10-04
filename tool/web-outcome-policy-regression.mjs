import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/Consumer/Web/WebOutcomePolicy.ts", import.meta.url), "utf8");

for (const token of [
  '"NETWORK_HUMAN_ACTION_REQUIRED"',
  '"waiting_human"',
  '"NETWORK_TARGET_STALE"',
  '"NETWORK_PAGE_REVISION_STALE"',
  '"NETWORK_FORM_REVISION_STALE"',
  '"reinspect"',
  '"NETWORK_SUBMIT_VALIDATION_FAILED"',
  '"needs_correction"',
  '"NETWORK_SUBMIT_VERIFIED"',
  '"terminal_success"',
  '"NETWORK_SUBMIT_POSTCONDITION_UNVERIFIED"',
  '"terminal_uncertain"',
  'automaticSubmitRetryAllowed: false',
  'never automatically repeat submit',
]) {
  assert.equal(source.includes(token), true, `Web outcome policy invariant missing: ${token}`);
}

assert.equal(
  source.includes('executionOwner: "console-mcp"'),
  true,
  "Console MCP must own Web execution outcome policy",
);

console.log("Console Web outcome policy regression passed.");

