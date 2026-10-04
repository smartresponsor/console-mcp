import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/tool/web-browser-bridge.ts", import.meta.url), "utf8");

assert.equal(
  source.includes('resolve(resolveMcpSiblingRepository("browsing"), "mcp-server", "src", "capability-contract.js")'),
  true,
  "Network capability contract must resolve from canonical sibling mcp/Browsing",
);

for (const token of [
  'expected_schema_version: 2',
  'boundary.browserOwner === "console-mcp"',
  'boundary.executionOwner === "console-mcp"',
  'boundary.orchestrationOwner === "console-mcp"',
  'boundary.capabilityOwner === "browser-mcp"',
  'boundary.domainStateOwner === "browser-mcp"',
  'boundary.genericAsyncLifecycleOwnedByNetwork === false',
  'boundary.genericExecutionLeaseOwnedByNetwork === false',
  'boundary.competingBrowserLaunchAllowed === false',
  'worker.browserAttachment === "console-owned-cdp"',
  'contract_version: contract.contractVersion ?? null',
  'risk_class: typeof tool.riskClass === "string"',
  'approval_policy: typeof tool.approvalPolicy === "string"',
  'replay_policy: typeof tool.replayPolicy === "string"',
  'postcondition: typeof tool.postcondition === "string"',
  'execution_correlation: typeof tool.executionCorrelation === "string"',
  'outcome_policy: webOutcomePolicySummary',
  'const webExecutionCorrelationSchema = z.object({',
  'runId: z.string().min(1).max(200).optional()',
  'owner: "console-mcp"',
  'const correlation = normalizeWebExecutionCorrelation(input.correlation);',
]) {
  assert.equal(source.includes(token), true, `Web Contract v2 bridge invariant missing: ${token}`);
}

assert.equal(
  source.includes('status: synergyReady ? "NETWORK_CAPABILITY_CONTRACT_READY" : "NETWORK_CAPABILITY_CONTRACT_DEGRADED"'),
  true,
  "Console bridge must surface degraded Network/Console contract symmetry instead of reporting unconditional readiness",
);

console.log("Console Web capability bridge regression passed.");

