#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = async (relative) => await readFile(path.join(root, relative), "utf8");

const browser = await read("src/engine/engine-cycle-browser.ts");
const engineTool = await read("src/tool/engine.ts");
const asyncRunner = await read("src/tool/engine-cycle-rounds-async-runner.ts");
const cli = await read("src/engine/engine-cli.ts");
const reaper = await read("src/service/engine-browser-target-reaper.ts");

assert.equal(browser.includes("CONSOLE_JEV_SHADOW_ENABLED"), false);
assert.equal(/jevShadow\??:\s*boolean;/.test(browser), true);
assert.equal(browser.includes("const jevShadowEnabled = options.jevShadow === true;"), true);
assert.equal(engineTool.includes('jevShadow: z.boolean().default(false)'), true);
assert.equal(engineTool.includes("jevShadow && workspacePath"), true);
assert.equal(engineTool.includes("jevShadow: input.jevShadow"), true);
assert.equal(engineTool.includes("jevShadow: stepInput.jevShadow"), true);
assert.equal(asyncRunner.includes("jevShadow: boolean;"), true);
assert.equal(asyncRunner.includes("jevShadow: input.jevShadow"), true);
assert.equal((cli.match(/--jev-shadow/g) ?? []).length >= 2, true);
assert.equal(reaper.includes("jevShadow: false"), true);

console.log(JSON.stringify({
  ok: true,
  status: "JEV_SHADOW_ACTIVATION_CONTRACT_GREEN",
  global_switch_removed: true,
  default_enabled: false,
  direct_gateway_opt_in: true,
  cycle_opt_in: true,
  async_opt_in: true,
  cli_opt_in: true,
  background_reaper_disabled: true
}));
