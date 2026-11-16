import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerNetworkHostTools } from "../dist/tool/network-host-tools.js";
import { consoleToolNames } from "../dist/tool/catalog.js";

const names = [];
const server = { registerTool(name, config, handler) { names.push(name); assert.equal(typeof handler, "function"); assert.ok(config.inputSchema); } };
registerNetworkHostTools(server, {});
const expected = ["read_.network.host.interfaces", "read_.network.serial.inventory", "read_.network.host.routes", "read_.network.host.neighbors"];
assert.deepEqual([...names].sort(), [...expected].sort(), "only approved passive network host registrations");
for (const name of expected) assert.ok(consoleToolNames.includes(name), `missing catalog ${name}`);
for (const file of ["policy/console-tool-admission.json", "policy/console-tool-catalog-read-infra.json"]) {
  const raw = readFileSync(file, "utf8");
  const json = JSON.parse(raw);
  for (const name of expected.slice(2)) assert.ok(raw.includes(name), `${file} missing ${name}`);
  for (const name of ["read_.network.ssh.capability", "read_.network.ssh.inspect"]) assert.ok(!raw.includes(name), `${file} unexpectedly admits ${name}`);
  assert.ok(json);
}
console.log("PASS passive network registration/catalog/admission without SSH");
