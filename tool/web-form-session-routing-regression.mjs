import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const guard=readFileSync(new URL("../src/service/visible-browser-tools.ts",import.meta.url),"utf8");
const bridge=readFileSync(new URL("../src/tool/web-domain-bridge.ts",import.meta.url),"utf8");
for(const op of ["write.web.form.proposal.preview","write.web.form.fill","write.web.form.review.snapshot","write.web.form.submit"]){
  assert.ok(guard.includes('name === "'+op+'"'),"exact-target guard missing "+op);
}
assert.ok(guard.includes('const visibleCdpPort = process.platform === "win32" ? runtimeCdpPort : 9224'),"centralized Windows/Ubuntu visible CDP routing missing");
assert.ok(guard.includes('input.browserSession === "visible" ? [visibleCdpPort]'),"visible CDP selection must use platform routing");
assert.ok(bridge.includes('process.platform === "win32" ? process.env.BROWSER_MCP_BROWSER_WORKER_URL || "http://127.0.0.1:8791"'),"Windows visible operations must reuse the existing Playwright worker");
assert.ok(bridge.includes('process.env.BROWSER_MCP_VISIBLE_WORKER_URL || "http://127.0.0.1:8793"'),"Ubuntu visible worker mapping must remain intact");
assert.ok(guard.includes('name.startsWith("write.web.form.")'),"verified form operations must preserve target binding");
assert.ok(bridge.includes('consoleName === "write.web.form.proposal.preview"'),"preview must choose visible worker");
assert.ok(bridge.includes('consoleName.startsWith("write.web.form.") && typeof rawInput.expectedTargetId === "string"'),"target-bound form commands must choose visible worker");
console.log("Web form browser-session source contract: PASS");
