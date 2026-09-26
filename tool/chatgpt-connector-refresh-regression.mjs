import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(root, "tool", "chatgpt-connector-refresh.mjs"), "utf8");

assert.match(
  source,
  /buildConnectorSettingsUrl\(connectorId\)/u,
  "connector refresh must derive its canonical entrypoint from the exact connector id",
);
assert.match(
  source,
  /#settings\/Plugins\/plugin_\$\{encodeURIComponent\(connectorId\)\}/u,
  "connector refresh must enter through the exact plugin detail route when the connector id is known",
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
  /status: "CONNECTOR_ID_REQUIRED"/u,
  "connector refresh must refuse browser navigation when an exact connector id is unavailable",
);
assert.match(
  source,
  /CONNECTOR_DETAIL_IDENTITY_NOT_RESOLVED/u,
  "connector refresh must refuse Refresh actions until the exact connector identity is visible",
);
assert.match(
  source,
  /initialPageText\.includes\(connectorId\) \|\| href\.includes\(connectorId\)/u,
  "lightweight refresh must gate actions on exact connector identity",
);
assert.match(
  source,
  /connectorPattern\.test\(item\.text\) \|\| \/Console MCP\/i\.test\(item\.text\)/u,
  "lightweight refresh must discover the connector by visible name",
);

const connectorPowerShellSource = readFileSync(join(root, "tool", "dev-console.d", "60-connector-refresh.ps1"), "utf8");
assert.match(connectorPowerShellSource, /schemaAlreadyCurrentBeforeUi/u, "connector refresh must compare schema fingerprints before any browser UI navigation");
assert.match(connectorPowerShellSource, /browser_navigation_performed = \$false/u, "schema-current refresh must explicitly record that browser navigation was skipped");
assert.match(connectorPowerShellSource, /event = 'connector_refresh_skipped'/u, "schema-current refresh must emit a correlated skip trace");
assert.match(connectorPowerShellSource, /\[string\]\$Reason = 'manual'/u, "connector refresh must record an explicit orchestration reason/initiator");

const watchdogHealSource = readFileSync(join(root, "tool", "dev-console.d", "41-watchdog-heal.ps1"), "utf8");
assert.match(watchdogHealSource, /\$beforeChatgptPid = \$chatgptState\.pid/u, "watchdog refresh must capture runtime identity before a recovery start");
assert.match(watchdogHealSource, /\[int\]\$afterChatgptState\.pid -ne \[int\]\$beforeChatgptPid/u, "watchdog must trigger schema refresh only after an actual ChatGPT runtime PID replacement");

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
  canonicalEntrypoint: "#settings/Plugins/plugin_<connector-id>",
}));
