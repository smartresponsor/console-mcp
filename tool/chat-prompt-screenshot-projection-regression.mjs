import assert from "node:assert/strict";
import { CanonicalToolRegistry } from "../dist/engine/canonical-tool-registry.js";
import { buildChatGptFacadeProjections, excludeLoopingFromMainChatGpt, LOOPING_OWNED_TOOL_NAMES } from "../dist/engine/mcp-facades.js";
import { listToolAdmissionDeclarations } from "../dist/engine/tool-admission.js";
import { registerEngineTools } from "../dist/tool/engine.js";
import { requiresVisibleBrowser } from "../dist/service/visible-browser-tools.js";

const name = "write.engine.chat.prompt.screenshot";
const auth = { mode: "oauth", readScope: "fixture:read", writeScope: "fixture:write" };
const captured = new Map();
registerEngineTools({ registerTool(n, config, handler) { captured.set(n, { config, handler }); } }, {}, "/fixture", auth);
const tool = captured.get(name);
assert.ok(tool);
const url = "https://chatgpt.com/s/t_0123456789abcdef0123456789abcdef";
assert.deepEqual(tool.config.inputSchema.parse({ url }), { url });
assert.equal(tool.config.inputSchema.safeParse({ url, ports: [9224] }).success, false);
assert.equal(tool.config.inputSchema.safeParse({ url: "https://example.com/" }).success, false);
assert.equal(tool.config.annotations.readOnlyHint, false);
assert.deepEqual(tool.config._meta.securitySchemes[0].scopes, ["fixture:write"]);
// Internal supervisor owns its lease; a second GUI lease would conflict.
assert.equal(requiresVisibleBrowser(name, { url }), false);
// Direct invalid invocation is rejected before any browser acquisition.
const invalid = await tool.handler({ url: "https://example.com/" });
assert.equal(invalid.isError, true);
assert.equal(invalid.structuredContent.status, "CHAT_PROMPT_SCREENSHOT_URL_INVALID");
assert.equal(invalid.content.some(x => x.type === "image"), false);

const declarations = listToolAdmissionDeclarations().filter(x => x.lifecycle !== "retired");
// Actual Engine registration, with other canonical names represented by the
// admission declarations already checked against the source AST by the gate.
const registry = CanonicalToolRegistry.build(sink => {
  registerEngineTools(sink, {}, "/fixture", auth);
  for (const d of declarations) if (!captured.has(d.name)) sink.registerTool(d.name, {}, async () => ({}));
});
const all = registry.forConsumer("chatgpt");
const projections = buildChatGptFacadeProjections(registry, "/mcp");
const looping = projections.get("/mcp/looping");
assert.equal(looping.toolCount, 27);
assert.equal(looping.toolNames.has(name), true);
assert.equal(LOOPING_OWNED_TOOL_NAMES.length, 27);
const main = excludeLoopingFromMainChatGpt(registry, all, looping);
assert.equal(main.toolCount, all.toolCount - 27);
assert.equal(main.toolNames.has(name), false);
const previousMain = [...all.toolNames].filter(n => n !== name && !LOOPING_OWNED_TOOL_NAMES.filter(x => x !== name).includes(n));
assert.deepEqual([...main.toolNames].sort(), previousMain.sort());
for (const [route, projection] of projections) if (route !== "/mcp/looping") assert.equal(projection.toolNames.has(name), false);
for (const consumer of ["codex", "runner"]) assert.equal(registry.forConsumer(consumer).toolNames.has(name), true);
console.log(JSON.stringify({ ok: true, status: "CHAT_PROMPT_SCREENSHOT_PROJECTION_PASS", loopingCount: looping.toolCount, mainCount: main.toolCount, mainDelta: 0, otherChatGptFacades: "excluded", sdkInput: "url_only", writeScope: "PASS", invalidUrl: "PASS" }));
