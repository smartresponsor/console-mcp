import assert from "node:assert/strict";
import { excludeLoopingFromMainChatGpt, LOOPING_OWNED_TOOL_NAMES } from "../dist/engine/mcp-facades.js";
const engine = new Set(LOOPING_OWNED_TOOL_NAMES);
assert.equal(engine.size, 26);
const network = "read_.network.sample";
const unrelated = "read_.system.sample";
const canonical = new Set([...engine, network, unrelated]);
const main = new Set([...engine, unrelated]);
const original = { consumer: "chatgpt", toolNames: main, toolCount: main.size, schemaFingerprint: "old" };
const facade = { consumer: "chatgpt", toolNames: engine, toolCount: 26, schemaFingerprint: "engine" };
const calls = [];
const registry = {
  forConsumer(name) { assert.equal(name, "chatgpt"); return { toolNames: canonical }; },
  forConsumerExcluding(name, excluded) {
    assert.equal(name, "chatgpt");
    calls.push(new Set(excluded));
    const visible = new Set([...canonical].filter((x) => !excluded.has(x)));
    return { consumer: name, toolNames: visible, toolCount: visible.size, schemaFingerprint: "filtered" };
  },
};
const result = excludeLoopingFromMainChatGpt(registry, original, facade);
assert.deepEqual([...result.toolNames], [unrelated]);
assert.equal(result.toolCount, original.toolCount - 26);
assert.equal(calls[0].has(network), true, "Network exclusion preserved");
assert.deepEqual([...original.toolNames], [...main], "input main untouched");
assert.deepEqual([...facade.toolNames], [...engine], "Looping facade untouched");
assert.throws(() => excludeLoopingFromMainChatGpt(registry, original, { ...facade, toolNames: new Set([...engine].slice(1)) }), /ownership mismatch/);
assert.throws(() => excludeLoopingFromMainChatGpt(registry, { ...original, toolNames: new Set([unrelated]), toolCount: 1 }, facade), /ownership mismatch/);
console.log("F2 Looping main exclusion regression: PASS");
