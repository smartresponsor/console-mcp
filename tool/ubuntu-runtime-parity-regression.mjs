import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "console-mcp-ubuntu-parity-"));
try {
  await mkdir(path.join(tempRoot, "var", "run", "engine", "task"), { recursive: true });
  await mkdir(path.join(tempRoot, "var", "log"), { recursive: true });
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  await writeFile(path.join(tempRoot, "var", "run", "engine", "task", "fresh.json"), JSON.stringify({ task_id: "fresh", status: "queued", updated_at: now }), "utf8");
  await writeFile(path.join(tempRoot, "var", "run", "engine", "task", "stale.json"), JSON.stringify({ task_id: "stale", status: "dispatch_ready", updated_at: stale }), "utf8");
  const pausedFile = path.join(tempRoot, "var", "run", "engine", "task", "paused.json");
  const paused = JSON.stringify({ task_id: "paused", status: "administratively_paused", updated_at: now });
  await writeFile(pausedFile, paused);
  const cli = path.join(root, "dist", "cli", "ubuntu-runtime-maintenance-cli.js");
  const first = await execFileAsync(process.execPath, [cli, `--root=${tempRoot}`, "--mcp-ok=false", "--cdp-ok=true", `--watchdog-pid=${process.pid}`], { cwd: root });
  assert.match(first.stdout, /UBUNTU_RUNTIME_MAINTENANCE_COMPLETE/);
  const failed = JSON.parse(await readFile(path.join(tempRoot, "var", "run", "runtime-stability-last.json"), "utf8"));
  assert.deepEqual(failed.current_failure_classes, ["MCP_PROTOCOL_UNRESPONSIVE"]);
  const second = await execFileAsync(process.execPath, [cli, `--root=${tempRoot}`, "--mcp-ok=true", "--cdp-ok=true", `--watchdog-pid=${process.pid}`], { cwd: root });
  assert.match(second.stdout, /UBUNTU_RUNTIME_MAINTENANCE_COMPLETE/);
  const recovering = JSON.parse(await readFile(path.join(tempRoot, "var", "run", "runtime-stability-last.json"), "utf8"));
  assert.equal(recovering.recent.stability, "RECOVERING");
  const env = JSON.parse(await readFile(path.join(tempRoot, "var", "run", "runtime-environment-last.json"), "utf8"));
  assert.equal(env.engine.pressure_counts.queued, 1);
  assert.equal(env.engine.stale_nonterminal_task_count, 1);
  const ledger = await readFile(path.join(tempRoot, "var", "log", "runtime-failures.ndjson"), "utf8");
  assert.match(ledger, /failure_started/); assert.match(ledger, /failure_recovered/);
  const { readRuntimeCapacity } = await import(pathToFileURL(path.join(root, "dist", "service", "runtime-capacity.js")));
  const capacity = readRuntimeCapacity(tempRoot);
  assert.equal(capacity.watchdog.fresh, true);
  assert.equal(capacity.resource_telemetry.fresh, true);
  if (env.resource_pressure.level === "CRITICAL") {
    assert.equal(capacity.decision, "DRAIN", "Real critical host pressure must remain fail-closed.");
    assert.ok(capacity.reasons.includes("RESOURCE_PRESSURE_CRITICAL"));
  } else {
    assert.notEqual(capacity.decision, "DRAIN");
  }
  assert.equal(capacity.watchdog.ownership_consistent, true);
  assert.equal(await readFile(pausedFile, "utf8"), paused, "Observer must preserve administrative pauses");
  env.sampled_at = stale;
  await writeFile(path.join(tempRoot, "var", "run", "runtime-environment-last.json"), JSON.stringify(env));
  const staleCapacity = readRuntimeCapacity(tempRoot);
  assert.equal(staleCapacity.allow_new_work, false);
  assert.ok(staleCapacity.reasons.includes("RESOURCE_TELEMETRY_STALE"));

  const watchdog = fs.readFileSync(path.join(root, "ops", "ubuntu", "script", "watchdog.sh"), "utf8");
  const maintenance = fs.readFileSync(path.join(root, "ops", "ubuntu", "script", "runtime-maintenance.sh"), "utf8");
  const service = fs.readFileSync(path.join(root, "ops", "ubuntu", "systemd", "console-mcp.service"), "utf8");
  const watchdogService = fs.readFileSync(path.join(root, "ops", "ubuntu", "systemd", "console-mcp-watchdog.service"), "utf8");
  const installer = fs.readFileSync(path.join(root, "ops", "ubuntu", "script", "install-systemd.sh"), "utf8");
  assert.match(watchdog, /runtime-maintenance\.sh/);
  assert.match(watchdog, /CONSOLE_MCP_WATCHDOG_ALLOW_RESTARTS:-false/);
  assert.match(watchdog, /ADMINISTRATIVELY_PAUSED/);
  assert.match(watchdog, /CRASHED/);
  assert.match(maintenance, /CONSOLE_MCP_WATCHDOG_ALLOW_BROWSER_CLEANUP:-false/);
  assert.match(maintenance, /engine-browser-target-reaper-cli\.js/);
  assert.match(maintenance, /plugin-settings-cleanup/);
  assert.match(service, /BindPaths=\/var\/lib\/console-mcp\/run:\/home\/alex\/smartresponse\/mcp\/console-mcp\/var\/run/);
  assert.match(watchdogService, /BindPaths=\/var\/lib\/console-mcp\/run:\/home\/alex\/smartresponse\/mcp\/console-mcp\/var\/run/);
  assert.match(installer, /\/var\/lib\/console-mcp\/run/);
  console.log(JSON.stringify({ ok: true, status: "UBUNTU_RUNTIME_PARITY_GREEN", recovery: true, age_aware_backlog: true, shared_capacity: true, browser_reaper: true, plugin_cleanup: true }));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
