import assert from "node:assert/strict";
import fs from "node:fs";
import { CanonicalToolRegistry } from "../dist/engine/canonical-tool-registry.js";
import { buildExclusiveNetworkProjections } from "../dist/engine/network-facade-ownership.js";

const registry = CanonicalToolRegistry.build((sink) => {
  sink.registerTool("read_.network.http.probe", { description: "Network read", inputSchema: {} }, () => ({}));
  sink.registerTool("read_.network.host.interfaces", { description: "Host read", inputSchema: {} }, () => ({}));
  sink.registerTool("read_.network.serial.inventory", { description: "Serial read", inputSchema: {} }, () => ({}));
  sink.registerTool("read_.network.host.routes", { description: "Routes read", inputSchema: {} }, () => ({}));
  sink.registerTool("read_.network.host.neighbors", { description: "ARP read", inputSchema: {} }, () => ({}));
  sink.registerTool("read_.network.ssh.capability", { description: "SSH policy", inputSchema: {} }, () => ({}));
  sink.registerTool("read_.network.ssh.inspect", { description: "SSH inspect", inputSchema: {} }, () => ({}));
  sink.registerTool("read_.system.console.describe", { description: "Console read", inputSchema: {} }, () => ({}));
});
const canonicalCount = registry.descriptors.length;
const network = registry.forSecondToken("chatgpt", "network");
assert.deepEqual([...network.toolNames].sort(), ["read_.network.host.interfaces", "read_.network.host.routes", "read_.network.http.probe", "read_.network.host.neighbors", "read_.network.serial.inventory", "read_.network.ssh.capability", "read_.network.ssh.inspect"].sort());
const enabled = buildExclusiveNetworkProjections(registry, true);
const disabled = buildExclusiveNetworkProjections(registry, false);
assert.deepEqual([...enabled.facade.toolNames].sort(), [...network.toolNames].sort());
assert.equal(disabled.facade, undefined);
assert.ok([...network.toolNames].every((name) => !disabled.main.toolNames.has(name)), "disabled façade must not expose Network through main");
const main = enabled.main;
assert.ok([...network.toolNames].every((name) => !main.toolNames.has(name)));
assert.equal(main.toolNames.has("read_.system.console.describe"), true);
assert.equal(registry.descriptors.length, canonicalCount);
assert.equal(registry.forConsumer("chatgpt").toolNames.has("read_.network.http.probe"), true);
assert.notEqual(main.schemaFingerprint, registry.forConsumer("chatgpt").schemaFingerprint);
assert.throws(() => registry.forConsumerExcluding("chatgpt", new Set(["read_.network.not.admitted"])), /unadmitted/);

const index = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
assert.match(index, /CONSOLE_MCP_NETWORK_FACADE_ENABLED/);
assert.match(index, /CONSOLE_MCP_NETWORK_FACADE_CUTOVER/);
assert.match(index, /const networkFacadePath = .*\/network/);
assert.match(index, /networkFacadeCutover && !networkFacadeEnabled/);
assert.match(index, /chatGptFacadeProjections\.set\(networkFacadePath, networkFacadeProjection\)/);
assert.match(index, /chatGptFacadeRequest && !networkFacadeRequest/);
assert.match(index, /buildExclusiveNetworkProjections\(canonicalRegistry, networkFacadeEnabled\)/);
assert.match(index, /consumerProjections\.chatgpt = exclusiveNetwork\.main/);
const mutation = {
  descriptors: [
    { name: "read_.network.http.probe", consumers: { chatgpt: true } },
    { name: "write.network.settings.set", consumers: { chatgpt: true } },
  ],
};
assert.throws(() => buildExclusiveNetworkProjections(mutation, true), /mutating write tools/);
console.log("NETWORK_FACADE_PROJECTION_PASS");
