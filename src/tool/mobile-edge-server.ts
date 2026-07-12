import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { runSupervisedCommand, truncateOutput } from "../Infrastructure/Process/SupervisedCommand.js";
import { assertAllowedRoot } from "../Policy/PathGuard.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { buildSafeEnv, resolveCommandExecutable, sanitizeText } from "../Infrastructure/Process/ProcessRuntime.js";
import { buildConsoleMutationToolRegistration, buildConsoleToolRegistration, textResult } from "./common.js";

const managedPackageName = "mobile-edge";
const allowedScripts = ["dev", "start"] as const;

type MobileEdgeScript = (typeof allowedScripts)[number];
type MobileEdgeAction = "status" | "start" | "stop" | "restart";

type MobileEdgeState = {
  packageName: "mobile-edge";
  pid: number;
  port: number;
  script: MobileEdgeScript;
  cwd: string;
  startedAt: string;
  healthUrl: string;
  stdoutLog: string;
  stderrLog: string;
};

type ProcessStatus = {
  pid: number | null;
  running: boolean;
  source: "state" | "none";
  statePath: string;
};

type HealthStatus = {
  ok: boolean;
  url: string;
  statusCode: number | null;
  body: string;
  error: string | null;
};

type SupervisedCommandShape = Awaited<ReturnType<typeof runSupervisedCommand>>;

export function registerMobileEdgeServerTool(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  const readRegistration = buildConsoleToolRegistration(authConfig);
  const mutationRegistration = buildConsoleMutationToolRegistration(authConfig);

  server.registerTool(
    "console.read_.runtime.mobile_edge.server.status",
    {
      description: "Inspect the managed Mobiling mobile-edge development server.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        port: z.number().int().min(1).max(65535).optional(),
        script: z.enum(allowedScripts).optional(),
        waitMs: z.number().int().min(1000).max(30000).optional(),
      }).strict(),
      ...readRegistration,
    },
    async ({ workspacePath, port, script, waitMs }) => textResult(await runMobileEdgeServer(policy, workspacePath, "status", port, script, waitMs))
  );

  server.registerTool(
    "console.write.runtime.mobile_edge.server.restart",
    {
      description: "Canonical write alias for console.mobile_edge_server restart.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        port: z.number().int().min(1).max(65535).optional(),
        script: z.enum(allowedScripts).optional(),
        waitMs: z.number().int().min(1000).max(30000).optional(),
      }).strict(),
      ...mutationRegistration,
    },
    async ({ workspacePath, port, script, waitMs }) => textResult(await runMobileEdgeServer(policy, workspacePath, "restart", port, script, waitMs))
  );
}

async function runMobileEdgeServer(policy: ConsolePolicy, workspacePath: string, action: MobileEdgeAction, portInput: number | undefined, scriptInput: MobileEdgeScript | undefined, waitMsInput: number | undefined): Promise<Record<string, unknown>> {
  const cwd = await resolveMobileEdgeWorkspace(policy, workspacePath);
  const port = portInput ?? 8080;
  const script = scriptInput ?? "dev";
  const waitMs = waitMsInput ?? 8000;
  const statePath = getStatePath(cwd);

  if (action === "status") {
    return await buildStatus(cwd, statePath, port);
  }

  if (action === "stop") {
    return await stopManagedServer(cwd, statePath, port);
  }

  if (action === "restart") {
    const stopped = await stopManagedServer(cwd, statePath, port);
    const started = await startManagedServer(cwd, statePath, port, script, waitMs);
    return { ok: Boolean(started.ok), action, stopped, started };
  }

  return await startManagedServer(cwd, statePath, port, script, waitMs);
}

async function resolveMobileEdgeWorkspace(policy: ConsolePolicy, workspacePath: string): Promise<string> {
  const base = assertAllowedRoot(workspacePath, policy.allowedRoots);
  const candidates = [base, path.join(base, managedPackageName)];

  for (const candidate of candidates) {
    const packagePath = path.join(candidate, "package.json");
    if (!existsSync(packagePath)) {
      continue;
    }

    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as { name?: unknown; scripts?: Record<string, unknown> };
    if (packageJson.name !== managedPackageName) {
      continue;
    }

    for (const script of allowedScripts) {
      if (typeof packageJson.scripts?.[script] !== "string") {
        throw new Error(`mobile-edge package is missing npm script: ${script}`);
      }
    }

    return candidate;
  }

  throw new Error(`Workspace must be the mobile-edge package directory or its Mobiling parent: ${base}`);
}

async function buildStatus(cwd: string, statePath: string, port: number): Promise<Record<string, unknown>> {
  const state = await readState(statePath);
  const processStatus = await getManagedProcessStatus(statePath, state);
  const health = await probeHealth(buildHealthUrl(port), 3000);
  return {
    ok: processStatus.running && health.ok,
    action: "status",
    cwd,
    port,
    managed: processStatus,
    health,
    state: state ? sanitizeState(state) : null,
  };
}

async function startManagedServer(cwd: string, statePath: string, port: number, script: MobileEdgeScript, waitMs: number): Promise<Record<string, unknown>> {
  const existingState = await readState(statePath);
  const existingProcess = await getManagedProcessStatus(statePath, existingState);
  const existingHealth = await probeHealth(buildHealthUrl(port), 3000);
  if (existingProcess.running && existingHealth.ok) {
    return {
      ok: true,
      action: "start",
      alreadyRunning: true,
      cwd,
      port,
      managed: existingProcess,
      health: existingHealth,
      state: existingState ? sanitizeState(existingState) : null,
    };
  }

  const runtimeDir = path.dirname(statePath);
  const logDir = path.join(runtimeDir, "mobile-edge-log");
  await mkdir(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stdoutLog = path.join(logDir, `${stamp}-stdout.log`);
  const stderrLog = path.join(logDir, `${stamp}-stderr.log`);
  const outFd = openSync(stdoutLog, "a");
  const errFd = openSync(stderrLog, "a");

  const npm = resolveCommandExecutable("npm").replaceAll("\"", "");
  const pwsh = resolveCommandExecutable("pwsh").replaceAll("\"", "");
  const command = `$env:PORT="${port}"; & "${npm}" run ${script}`;
  const startedAt = new Date().toISOString();

  try {
    const child = spawn(pwsh, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
      cwd,
      detached: true,
      windowsHide: true,
      env: {
        ...buildSafeEnv(),
        PORT: String(port),
      },
      stdio: ["ignore", outFd, errFd],
    });

    child.unref();
    const state: MobileEdgeState = {
      packageName: managedPackageName,
      pid: child.pid ?? 0,
      port,
      script,
      cwd,
      startedAt,
      healthUrl: buildHealthUrl(port),
      stdoutLog,
      stderrLog,
    };
    await writeState(statePath, state);

    const health = await waitForHealth(state.healthUrl, waitMs);
    const processStatus = await getManagedProcessStatus(statePath, state);
    return {
      ok: processStatus.running && health.ok,
      action: "start",
      alreadyRunning: false,
      cwd,
      port,
      script,
      managed: processStatus,
      health,
      state: sanitizeState(state),
    };
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
}

async function stopManagedServer(cwd: string, statePath: string, port: number): Promise<Record<string, unknown>> {
  const state = await readState(statePath);
  const before = await getManagedProcessStatus(statePath, state);
  if (!state || !before.running || state.pid <= 0) {
    const health = await probeHealth(buildHealthUrl(port), 3000);
    return {
      ok: !health.ok,
      action: "stop",
      stopped: false,
      reason: state ? "managed_process_not_running" : "managed_state_not_found",
      cwd,
      port,
      managed: before,
      health,
      state: state ? sanitizeState(state) : null,
    };
  }

  const taskkill = await runSupervisedCommand(cwd, "taskkill", ["/PID", String(state.pid), "/T", "/F"], 30000, 1024 * 1024);
  await rm(statePath, { force: true });
  await sleep(1000);
  const health = await probeHealth(buildHealthUrl(state.port), 3000);
  return {
    ok: taskkill.ok || !health.ok,
    action: "stop",
    stopped: taskkill.ok,
    cwd,
    port: state.port,
    taskkill: sanitizeCommandResult(taskkill),
    managedBefore: before,
    health,
    state: sanitizeState(state),
  };
}

function getStatePath(cwd: string): string {
  return path.join(cwd, ".console-mcp", "mobile-edge-server.json");
}

async function readState(statePath: string): Promise<MobileEdgeState | null> {
  if (!existsSync(statePath)) {
    return null;
  }

  const parsed = JSON.parse(await readFile(statePath, "utf8")) as Partial<MobileEdgeState>;
  if (parsed.packageName !== managedPackageName || typeof parsed.pid !== "number") {
    return null;
  }

  return parsed as MobileEdgeState;
}

async function writeState(statePath: string, state: MobileEdgeState): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function getManagedProcessStatus(statePath: string, state: MobileEdgeState | null): Promise<ProcessStatus> {
  if (!state || state.pid <= 0) {
    return { pid: null, running: false, source: "none", statePath };
  }

  return { pid: state.pid, running: await isProcessRunning(state.pid), source: "state", statePath };
}

async function isProcessRunning(pid: number): Promise<boolean> {
  if (pid <= 0) {
    return false;
  }

  const result = await runSupervisedCommand(process.cwd(), "tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], 30000, 1024 * 1024);
  return result.ok && result.stdout.includes(`"${pid}"`);
}

async function waitForHealth(url: string, waitMs: number): Promise<HealthStatus> {
  const started = Date.now();
  let last = await probeHealth(url, 3000);
  while (!last.ok && Date.now() - started < waitMs) {
    await sleep(500);
    last = await probeHealth(url, 3000);
  }

  return last;
}

function probeHealth(url: string, timeoutMs: number): Promise<HealthStatus> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const req = httpRequest(url, { method: "GET", timeout: timeoutMs, headers: { Accept: "application/json,text/plain,*/*;q=0.5", "User-Agent": "console-mcp-mobile-edge/1.0" } }, (res) => {
      res.on("data", (chunk: Buffer | string) => {
        if (chunks.reduce((sum, item) => sum + item.length, 0) < 8192) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
      });
      res.on("end", () => {
        const body = truncateOutput(sanitizeText(Buffer.concat(chunks).toString("utf8")), 8192).text;
        const statusCode = res.statusCode ?? null;
        resolve({ ok: statusCode !== null && statusCode >= 200 && statusCode < 400, url, statusCode, body, error: null });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`Request timed out after ${timeoutMs} ms.`)));
    req.on("error", (error) => resolve({ ok: false, url, statusCode: null, body: "", error: error instanceof Error ? error.message : String(error) }));
    req.end();
  });
}

function buildHealthUrl(port: number): string {
  return `http://127.0.0.1:${port}/health`;
}

function sanitizeState(state: MobileEdgeState): Record<string, unknown> {
  return {
    packageName: state.packageName,
    pid: state.pid,
    port: state.port,
    script: state.script,
    cwd: state.cwd,
    startedAt: state.startedAt,
    healthUrl: state.healthUrl,
    stdoutLog: state.stdoutLog,
    stderrLog: state.stderrLog,
  };
}

function sanitizeCommandResult(result: SupervisedCommandShape): Record<string, unknown> {
  const stdout = truncateOutput(result.stdout);
  const stderr = truncateOutput(result.stderr);
  return {
    ok: result.ok,
    command: result.command,
    args: result.args,
    cwd: result.cwd,
    exitCode: result.exitCode,
    stdout: stdout.text,
    stdoutTruncated: stdout.truncated,
    stderr: stderr.text,
    stderrTruncated: stderr.truncated,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

