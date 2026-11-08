import assert from "node:assert/strict";
import { registerReleaseBrokerTools } from "../dist/tool/release-broker.js";

const registrations = new Map();
const server = {
  registerTool(name, config, handler) {
    registrations.set(name, { config, handler });
  },
};

registerReleaseBrokerTools(server, {});

const transactionTools = [
  "read_.release.transaction.status",
  "write.release.transaction.prepare",
  "write.release.transaction.validate",
  "write.release.transaction.activate",
  "write.release.transaction.rollback",
];
for (const name of transactionTools) assert.ok(registrations.has(name), `${name} must be registered`);

const transactionId = "a".repeat(32);
const sha = "b".repeat(40);
assert.equal(registrations.get(transactionTools[0]).config.inputSchema.safeParse({ transactionId }).success, true);
assert.equal(registrations.get(transactionTools[0]).config.inputSchema.safeParse({ transactionId: "short" }).success, false);
assert.equal(registrations.get(transactionTools[1]).config.inputSchema.safeParse({ sha, confirm: true }).success, true);
assert.equal(registrations.get(transactionTools[1]).config.inputSchema.safeParse({ sha: "HEAD", confirm: true }).success, false);
for (const name of ["write.release.runtime.activate", "write.release.runtime.rollback"]) {
  assert.equal(registrations.get(name).config.inputSchema.safeParse({ transactionId, confirm: true }).success, true);
  assert.equal(registrations.get(name).config.inputSchema.safeParse({ sha, confirm: true }).success, false, `${name} must reject SHA-only cutover`);
}

for (const name of transactionTools.slice(1)) {
  const input = name.endsWith("prepare") ? { sha, confirm: false } : { transactionId, confirm: false };
  const result = await registrations.get(name).handler(input);
  assert.equal(result.structuredContent.status, "RELEASE_EXPLICIT_CONFIRMATION_REQUIRED", `${name} must fail closed without confirmation`);
}

assert.match(registrations.get("write.release.transaction.activate").config.description, /exact transaction ID and explicit confirmation/i);
console.log(JSON.stringify({ ok: true, status: "RELEASE_TRANSACTION_MCP_CONTRACT_GREEN", tools: transactionTools }));
