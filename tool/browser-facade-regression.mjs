import assert from "node:assert/strict";
import fs from "node:fs";

const file = path => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const facade = file("../src/engine/mcp-facades.ts");
const registry = file("../src/engine/canonical-tool-registry.ts");
const bridge = file("../src/tool/web-browser-bridge.ts");
const guard = file("../src/service/visible-browser-tools.ts");
const catalog = JSON.parse(file("../policy/console-tool-catalog-chatgpt-browser.json"));
const admission = JSON.parse(file("../policy/console-tool-admission.json"));

assert.match(facade, /CHATGPT_FACADE_GROUPS = \["repo", "runtime", "browser"\]/);
assert.match(facade, /forSecondToken\("chatgpt", group\)/);
assert.match(registry, /forSecondToken\(consumer: ConsumerName, token: string\)/);
assert.ok(catalog.tools.some(tool => tool.canonicalName === "write.browser.tab.close" && tool.mutatesBrowser));
assert.ok(admission.declarations.some(tool => tool.name === "write.browser.tab.close" && tool.consumers.includes("chatgpt")));
assert.match(bridge, /server\.registerTool\("write\.browser\.tab\.close"/);
assert.match(bridge, /visibleCdpCommand\(endpoint, "Target\.closeTarget"/);
assert.match(bridge, /WEB_TARGET_EDITABLE_CONTENT_GUARD/);
assert.match(bridge, /WEB_TARGET_IDENTITY_OR_LAST_PAGE_GUARD/);
assert.match(guard, /name === "write\.browser\.tab\.close" \? \[visibleCdpPort\]/);
assert.match(guard, /body\.status === "WEB_TARGET_CLOSED"/);
assert.match(guard, /postcondition_verified: true/);
assert.match(guard, /const background = name === "write.browser.tab.close"/);
assert.match(guard, /name === "write.browser.tab.close" \|\| \(process.platform === "win32"/);
assert.match(bridge, /targetId: input.targetId, background: true, capability: "cdp"/);
console.log("browser facade canonical registration and fail-closed tab close: PASS");
