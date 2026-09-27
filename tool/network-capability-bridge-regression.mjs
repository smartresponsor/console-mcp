import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/tool/network-browser-bridge.ts", import.meta.url), "utf8");

assert.equal(
  source.includes('resolve(process.cwd(), "..", "network-mcp", "mcp-server", "src", "capability-contract.js")'),
  true,
  "Network capability contract must resolve from canonical sibling mcp/network-mcp",
);

for (const token of [
  'expected_schema_version: 2',
  'boundary.browserOwner === "console-mcp"',
  'boundary.executionOwner === "console-mcp"',
  'boundary.orchestrationOwner === "console-mcp"',
  'boundary.capabilityOwner === "network-mcp"',
  'boundary.domainStateOwner === "network-mcp"',
  'boundary.genericAsyncLifecycleOwnedByNetwork === false',
  'boundary.genericExecutionLeaseOwnedByNetwork === false',
  'boundary.competingBrowserLaunchAllowed === false',
  'worker.browserAttachment === "console-owned-cdp"',
  'contract_version: contract.contractVersion ?? null',
  'risk_class: typeof tool.riskClass === "string"',
  'approval_policy: typeof tool.approvalPolicy === "string"',
  'replay_policy: typeof tool.replayPolicy === "string"',
  'postcondition: typeof tool.postcondition === "string"',
  'const networkExecutionCorrelationSchema = z.object({',
  'runId: z.string().min(1).max(200).optional()',
  'owner: "console-mcp"',
  'const correlation = normalizeNetworkExecutionCorrelation(input.correlation);',
]) {
  assert.equal(source.includes(token), true, `Network Contract v2 bridge invariant missing: ${token}`);
}

assert.equal(
  source.includes('status: synergyReady ? "NETWORK_CAPABILITY_CONTRACT_READY" : "NETWORK_CAPABILITY_CONTRACT_DEGRADED"'),
  true,
  "Console bridge must surface degraded Network/Console contract symmetry instead of reporting unconditional readiness",
);

console.log("Console Network capability bridge regression passed.");

