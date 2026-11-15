import assert from "node:assert/strict";
import { inspectSshCapability, inspectSshDevice } from "../dist/tool/network-ssh-scrapli.js";

const capability = await inspectSshCapability();
assert.equal(capability.ok, true);
assert.equal(capability.engine, "scrapli");
assert.equal(capability.authorizedTargets, "never supplied by ChatGPT");
assert.ok(typeof capability.status === "string");

for (const [id, obs] of [
  ["../../etc/shadow", "version"], ["x".repeat(49), "version"],
  ["lab", "reload"], ["lab", "show running-config"],
  ["127.0.0.1", "version"],
]) {
  const result = await inspectSshDevice(id, obs);
  assert.equal(result.ok, false);
  assert.equal(result.status, "SSH_REQUEST_INVALID");
}

const unprovisioned = await inspectSshDevice("authorized_lab", "version");
assert.equal(unprovisioned.ok, false, "no SSH should execute without approved worker provisioning");
assert.ok(["SSH_ENGINE_UNAVAILABLE", "CONFIGURATION_UNAVAILABLE", "SSH_PLATFORM_NOT_PROVISIONED"].includes(unprovisioned.status),
  "unexpected policy state: " + unprovisioned.status);

console.log("NETWORK_SSH_GATED_ADAPTER_PASS", JSON.stringify({
  platform: process.platform, engine: capability.status,
  deniedInvalidRequests: 5, unprovisionedStatus: unprovisioned.status,
}));
