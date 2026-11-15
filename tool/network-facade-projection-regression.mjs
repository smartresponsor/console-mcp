import assert from "node:assert/strict";
import fs from "node:fs";
import { CanonicalToolRegistry } from "../dist/engine/canonical-tool-registry.js";
import { buildExclusiveNetworkProjections } from "../dist/engine/network-facade-ownership.js";

const registry = CanonicalToolRegistry.build((sink) => {
  sink.registerTool("read_.network.http.probe", { description: "Network read", inputSchema: {} }, () => ({}));
  sink.registerTool("read_.system.console.describe", { description: "Console read", inputSchema: {} }, () => ({}));
});
const canonicalCount = registry.descriptors.length;
const network = registry.forSecondToken("chatgpt", "network");
assert.deepEqual([...network.toolNames], ["read_.network.http.probe"]);
const enabled = buildExclusiveNetworkProjections(registry, true);
const disabled = buildExclusiveNetworkProjections(registry, false);
assert.deepEqual([...enabled.facade.toolNames], ["read_.network.http.probe"]);
assert.equal(disabled.facade, undefined);
assert.equal(disabled.main.toolNames.has("read_.network.http.probe"), false, "disabled façade must not expose Network through main");
const main = enabled.main;
assert.equal(main.toolNames.has("read_.network.http.probe"), false);
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
const mutation = CanonicalToolRegistry.build((sink) => {
  sink.registerTool("read_.network.http.probe", { description: "safe", inputSchema: {} }, () => ({}));
  sink.registerTool("write.network.settings.set", { description: "unsafe", inputSchema: {} }, () => ({}));
});
assert.throws(() => buildExclusiveNetworkProjections(mutation, true), /mutating write tools/);
console.log("NETWORK_FACADE_PROJECTION_PASS");
