import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(root, "tool", "chatgpt-connector-refresh.mjs"), "utf8");

assert.match(
  source,
  /function buildConnectorSettingsUrl\(\)\s*\{\s*return "https:\/\/chatgpt\.com\/settings\/plugins-settings";/u,
  "connector refresh must enter through the current Plugins settings surface",
);
assert.doesNotMatch(
  source,
  /CONSOLE_MCP_CHATGPT_CONNECTOR_ID \?\? "asdk_app_/u,
  "connector refresh must not carry a hardcoded ChatGPT plugin id",
);
assert.match(
  source,
  /CONNECTOR_DETAIL_NAVIGATION_REQUESTED/u,
  "connector refresh must support name-based navigation from the Plugins list to plugin details",
);
assert.match(
  source,
  /location\.hash\.startsWith\('#settings\/Plugins\/plugin_'\)/u,
  "connector refresh must recognize the current plugin detail route without embedding an id",
);
assert.match(
  source,
  /connectorPattern\.test\(item\.text\) \|\| \/Console MCP\/i\.test\(item\.text\)/u,
  "lightweight refresh must discover the connector by visible name",
);

const cleanerSource = readFileSync(join(root, "src", "service", "chatgpt-plugin-settings-cleaner.ts"), "utf8");
assert.match(cleanerSource, /\/settings\/plugins-settings/u, "plugin settings cleaner must recognize the current path route");
assert.match(cleanerSource, /#settings\\\/Plugins\(\?:\\\/plugin_/u, "plugin settings cleaner must recognize generic and detail legacy hash routes");
assert.doesNotMatch(source, /return pages\.find\(\(target\) => isChatGptSettingsUrl\(target\.url\)\)/u, "settings targets must never be cleanup keepers");
assert.match(source, /cleanupAfter = await cleanupBrowserTargetsAcrossPorts\(ports, timeoutMs, "after-refresh"\)/u, "successful connector refresh must perform after-refresh cleanup");
assert.match(source, /if \(!cleanupAfter\)[\s\S]*cleanupBrowserTargetsAcrossPorts\(ports, timeoutMs, "after-refresh"\)/u, "failed connector refresh must still perform after-refresh cleanup");
assert.match(source, /location\.pathname === '\/settings\/plugins-settings'/u, "refresh expressions must recognize the current settings path without redirect loops");

console.log(JSON.stringify({
  ok: true,
  status: "CHATGPT_CONNECTOR_REFRESH_REGRESSION_GREEN",
  hardcodedConnectorId: false,
  canonicalEntrypoint: "/settings/plugins-settings",
}));
