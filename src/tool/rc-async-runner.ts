import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConsolePolicy } from "../Policy/ConsolePolicy.js";
import { executeRcDiagnose } from "./rc.js";

type RcAsyncConfig = {
  workspacePath: string;
  component: string | null;
  target: string | null;
  mode: "diagnose" | "validate" | "plan" | "full";
  maxFiles: number;
  maxIssues: number;
  runEnvelope: never;
  writeEvidence: boolean;
  timeoutMs: number;
};

const configPath = process.argv[2];
if (!configPath) {
  console.error("Usage: node dist/tool/rc-async-runner.js <config.json>");
  process.exit(64);
}

try {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const policy = await loadConsolePolicy(projectRoot);
  const config = JSON.parse(await readFile(configPath, "utf8")) as RcAsyncConfig;
  const result = await executeRcDiagnose(
    policy,
    config.workspacePath,
    config.component,
    config.target,
    config.mode,
    config.maxFiles,
    config.maxIssues,
    config.runEnvelope,
    config.writeEvidence,
    config.timeoutMs,
  );
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok === false ? 1 : 0);
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    tool: "console.rc.async_runner",
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
}
