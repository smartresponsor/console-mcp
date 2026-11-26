import assert from "node:assert/strict";
import { requiresOwnerBaseline, baselineProvenanceMatches, captureOwnerBaseline } from "../dist/engine/preservation-baseline.js";
const protectedPath = "/home/alex/smartresponse/mcp";
const legacy = "a".repeat(64);
const versioned = "preservation-v3:" + legacy;
if (process.platform === "linux") {
  assert.equal(requiresOwnerBaseline(protectedPath), true);
  assert.equal(baselineProvenanceMatches(protectedPath, legacy), false);
  assert.equal(baselineProvenanceMatches(protectedPath, versioned), true);
  assert.equal(baselineProvenanceMatches(protectedPath, "preservation-v1:" + legacy), false);
  assert.equal(baselineProvenanceMatches(protectedPath, "preservation-v2:" + legacy), false);
  if (process.getuid() === 993) {
    assert.equal(requiresOwnerBaseline("/tmp/native-fixture"), true);
    assert.equal(baselineProvenanceMatches("/tmp/native-fixture", legacy), false);
  }
  if (!process.env.CONSOLE_MCP_PRESERVATION_SOCKET) {
    await assert.rejects(captureOwnerBaseline(protectedPath), /PRESERVATION_CONFIGURATION/);
  }
}
console.log("M5_PROVIDER_POLICY_GREEN");
