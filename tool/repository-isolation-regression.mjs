import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const { runWithMcpRequestContext, getMcpRequestContext } = await import(pathToFileURL(path.join(root, "dist", "Infrastructure", "Diagnostics", "RequestContext.js")));
const { runSupervisedCommand } = await import(pathToFileURL(path.join(root, "dist", "Infrastructure", "Process", "SupervisedCommand.js")));
const { buildRepositoryRegistry, resolveRepositoryScope } = await import(pathToFileURL(path.join(root, "dist", "service", "repository-registry.js")));

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "console-mcp-repo-isolation-"));

try {
  const locating = path.join(tempRoot, "Locating");
  const cataloging = path.join(tempRoot, "nested", "Cataloging");
  await mkdir(path.join(locating, ".git"), { recursive: true });
  await mkdir(cataloging, { recursive: true });
  await writeFile(path.join(cataloging, "composer.json"), JSON.stringify({ name: "example/cataloging" }), "utf8");

  const policy = {
    workspaceRoot: tempRoot,
    allowedRoots: [tempRoot],
  };

  const registry = await buildRepositoryRegistry(policy);
  assert.equal(registry.ok, true);
  assert.equal(registry.entries.some((entry) => entry.relativeWorkspacePath === "Locating"), true);
  assert.equal(registry.entries.some((entry) => entry.relativeWorkspacePath === "nested/Cataloging"), true);

  const locatingScope = await resolveRepositoryScope(policy, { componentName: "Locating" });
  assert.equal(locatingScope.workspacePath, path.resolve(locating));
  assert.equal(locatingScope.scopeId, "locating");

  const catalogingScope = await resolveRepositoryScope(policy, { componentName: "nested/Cataloging" });
  assert.equal(catalogingScope.workspacePath, path.resolve(cataloging));
  assert.equal(catalogingScope.scopeId, "nested.cataloging");

  const observed = await runWithMcpRequestContext("mcp-regression", async () => {
    const [left, right] = await Promise.all([
      runSupervisedCommand(locating, process.execPath, ["-e", "console.log(process.cwd())"], 30000, 1024 * 1024),
      runSupervisedCommand(cataloging, process.execPath, ["-e", "console.log(process.cwd())"], 30000, 1024 * 1024),
    ]);
    assert.equal(left.ok, true);
    assert.equal(right.ok, true);
    assert.equal(path.resolve(left.stdout.trim()).toLowerCase(), path.resolve(locating).toLowerCase());
    assert.equal(path.resolve(right.stdout.trim()).toLowerCase(), path.resolve(cataloging).toLowerCase());
    return getMcpRequestContext()?.repositoryExecutions ?? [];
  });

  assert.equal(observed.length, 2);
  assert.deepEqual(new Set(observed.map((item) => path.resolve(item.cwd).toLowerCase())), new Set([path.resolve(locating).toLowerCase(), path.resolve(cataloging).toLowerCase()]));

  const responsivenessStarted = Date.now();
  let timerDelay = null;
  const slow = runSupervisedCommand(locating, process.execPath, ["-e", "setTimeout(() => console.log('done'), 1000)"], 5000, 1024 * 1024);
  await new Promise((resolve) => setTimeout(() => {
    timerDelay = Date.now() - responsivenessStarted;
    resolve();
  }, 50));
  assert.ok(timerDelay < 500, `event loop timer was delayed by ${timerDelay}ms`);
  assert.equal((await slow).ok, true);

  const healthSource = await import("node:fs/promises").then((fs) => fs.readFile(path.join(root, "src", "tool", "health.ts"), "utf8"));
  assert.equal(healthSource.includes("spawnSync"), false, "health fast path must not use synchronous child-process detection");

  console.log(JSON.stringify({
    ok: true,
    registry_count: registry.entries.length,
    concurrent_repository_scopes: [locatingScope.relativeWorkspacePath, catalogingScope.relativeWorkspacePath],
    observed_execution_count: observed.length,
    event_loop_timer_delay_ms: timerDelay,
  }, null, 2));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
