import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const { runWithMcpRequestContext, getMcpRequestContext } = await import(pathToFileURL(path.join(root, "dist", "Infrastructure", "Diagnostics", "RequestContext.js")));
const { runSupervisedCommand } = await import(pathToFileURL(path.join(root, "dist", "Infrastructure", "Process", "SupervisedCommand.js")));
const { buildRepositoryRegistry, invalidateRepositoryRegistry, resolveRepositoryScope } = await import(pathToFileURL(path.join(root, "dist", "service", "repository-registry.js")));
const { createRepositoryBinding, resolveRepositoryBinding, resolveRepositoryScopeWithBinding } = await import(pathToFileURL(path.join(root, "dist", "service", "repository-binding.js")));

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
    transcriptDir: path.join(tempRoot, ".console-mcp", "transcript"),
  };

  const registry = await buildRepositoryRegistry(policy);
  assert.equal(registry.ok, true);
  assert.equal(registry.entries.some((entry) => entry.relativeWorkspacePath === "Locating"), true);
  assert.equal(registry.entries.some((entry) => entry.relativeWorkspacePath === "nested/Cataloging"), true);

  const cachedRegistry = await buildRepositoryRegistry(policy);
  assert.equal(cachedRegistry, registry, "registry should be served from the short-lived cache");

  const concurrentRegistries = await Promise.all([
    buildRepositoryRegistry(policy),
    buildRepositoryRegistry(policy),
    buildRepositoryRegistry(policy),
  ]);
  assert.equal(concurrentRegistries.every((item) => item === registry), true, "concurrent lookups should reuse the cached registry snapshot");

  const added = path.join(tempRoot, "Added");
  await mkdir(path.join(added, ".git"), { recursive: true });
  assert.equal((await buildRepositoryRegistry(policy)).entries.some((entry) => entry.relativeWorkspacePath === "Added"), false, "cached snapshot should remain stable until invalidated or expired");
  invalidateRepositoryRegistry(tempRoot);
  const refreshedRegistry = await buildRepositoryRegistry(policy);
  assert.equal(refreshedRegistry.entries.some((entry) => entry.relativeWorkspacePath === "Added"), true, "explicit invalidation should refresh repository discovery");

  const locatingScope = await resolveRepositoryScope(policy, { componentName: "Locating" });
  assert.equal(locatingScope.workspacePath, path.resolve(locating));
  assert.equal(locatingScope.scopeId, "locating");

  const catalogingScope = await resolveRepositoryScope(policy, { componentName: "nested/Cataloging" });
  assert.equal(catalogingScope.workspacePath, path.resolve(cataloging));
  assert.equal(catalogingScope.scopeId, "nested.cataloging");

  const createdBinding = await createRepositoryBinding(policy, { componentName: "Locating" });
  assert.equal(createdBinding.scope.scopeId, "locating");
  assert.match(createdBinding.binding.bindingId, /^[0-9a-f-]{36}$/i);

  const resolvedBinding = await resolveRepositoryBinding(policy, createdBinding.binding.bindingId);
  assert.equal(resolvedBinding.scope.workspacePath, path.resolve(locating));
  assert.equal(resolvedBinding.binding.scopeId, "locating");

  const boundScope = await resolveRepositoryScopeWithBinding(policy, { bindingId: createdBinding.binding.bindingId });
  assert.equal(boundScope.workspacePath, path.resolve(locating));
  assert.equal(boundScope.source, "binding");

  await assert.rejects(
    () => resolveRepositoryScopeWithBinding(policy, { bindingId: createdBinding.binding.bindingId, componentName: "nested/Cataloging" }),
    /Repository binding conflicts/,
    "binding must reject a conflicting compatibility componentName",
  );

  const bindingState = await readFile(path.join(policy.transcriptDir, "repository-bindings", `${createdBinding.binding.bindingId}.json`), "utf8");
  assert.match(bindingState, /"scopeId": "locating"/, "binding must persist durably under transcript state");

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
  assert.equal(healthSource.includes("refreshIfNeeded();"), true, "health PowerShell capability cache must refresh after startup");
  assert.equal(healthSource.includes("refreshInFlight"), true, "health PowerShell capability refresh must be deduplicated");
  const indexSource = await import("node:fs/promises").then((fs) => fs.readFile(path.join(root, "src", "index.ts"), "utf8"));
  const runtimeEventsSource = await import("node:fs/promises").then((fs) => fs.readFile(path.join(root, "src", "Infrastructure", "Diagnostics", "RuntimeProcessEvents.ts"), "utf8"));
  assert.equal(indexSource.includes("installRuntimeProcessEventLogging"), true, "runtime entrypoint must install persistent process event logging");
  assert.equal(runtimeEventsSource.includes("console-mcp-runtime-events.ndjson"), true, "runtime process events must be persisted to a stable log file");
  assert.equal(runtimeEventsSource.includes("uncaughtExceptionMonitor"), true, "runtime process events must observe uncaught exceptions without swallowing default crash behavior");
  assert.equal(runtimeEventsSource.includes("unhandledRejection"), true, "runtime process events must record unhandled promise rejections");
  assert.equal(runtimeEventsSource.includes("process_exit"), true, "runtime process events must record exit evidence");

  console.log(JSON.stringify({
    ok: true,
    registry_count: registry.entries.length,
    refreshed_registry_count: refreshedRegistry.entries.length,
    concurrent_repository_scopes: [locatingScope.relativeWorkspacePath, catalogingScope.relativeWorkspacePath],
    durable_binding_scope: boundScope.relativeWorkspacePath,
    observed_execution_count: observed.length,
    event_loop_timer_delay_ms: timerDelay,
  }, null, 2));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
