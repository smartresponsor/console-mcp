import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createEnginePaths } from "../engine/engine-core.js";
import { runEngineCycleRounds } from "../engine/engine-cycle-browser.js";
import { assertAllowedRoot } from "../Policy/PathGuard.js";
import { loadConsolePolicy } from "../Policy/ConsolePolicy.js";

type EngineCycleRoundsAsyncConfig = {
  baseDir: string;
  input: {
    taskId: string;
    ports: number[];
    url: string;
    activate: boolean;
    allowOverwrite: boolean;
    maxMessages: number;
    timeoutMs: number;
    readinessProfile: "quick_probe" | "rc_gate" | "long_run";
    maxWaitMs?: number;
    observationBudgetMs?: number;
    pollMs?: number;
    gatewayModel?: string;
    gatewayMaxOutputTokens: number;
    gatewayTemperature: number;
    gatewayTimeoutMs: number;
    gatewayRaw: boolean;
    gatewayConsoleEndpoint?: string;
    maxRounds: number;
    maxStepsPerRound: number;
    stopOnBlocked: boolean;
    stopOnNotReady: boolean;
  };
};

const configPath = process.argv[2];
if (!configPath) {
  console.error("Usage: node dist/tool/engine-cycle-rounds-async-runner.js <config.json>");
  process.exit(64);
}

try {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const policy = await loadConsolePolicy(projectRoot);
  const config = JSON.parse(await readFile(configPath, "utf8")) as EngineCycleRoundsAsyncConfig;
  await rm(configPath, { force: true });

  const baseDir = assertAllowedRoot(path.resolve(config.baseDir), policy.allowedRoots);
  const paths = createEnginePaths(baseDir);
  const input = config.input;

  const result = await runEngineCycleRounds(paths, {
    policy,
    baseDir,
    ports: input.ports,
    url: input.url,
    activate: input.activate,
    allowOverwrite: input.allowOverwrite,
    maxMessages: input.maxMessages,
    timeoutMs: input.timeoutMs,
    readinessProfile: input.readinessProfile,
    maxWaitMs: input.maxWaitMs,
    observationBudgetMs: input.observationBudgetMs,
    pollMs: input.pollMs,
    gatewayModel: input.gatewayModel,
    gatewayMaxOutputTokens: input.gatewayMaxOutputTokens,
    gatewayTemperature: input.gatewayTemperature,
    gatewayTimeoutMs: input.gatewayTimeoutMs,
    gatewayRaw: input.gatewayRaw,
    gatewayConsoleEndpoint: input.gatewayConsoleEndpoint,
  }, {
    taskId: input.taskId,
    maxRounds: input.maxRounds,
    maxStepsPerRound: input.maxStepsPerRound,
    stopOnBlocked: input.stopOnBlocked,
    stopOnNotReady: input.stopOnNotReady,
  });

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok === false ? 1 : 0);
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    tool: "console.engine.cycle.rounds.async_runner",
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
}
