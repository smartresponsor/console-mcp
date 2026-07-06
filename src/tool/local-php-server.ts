import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { normalizeRepoPath, runSupervisedCommand, truncateOutput } from "../Infrastructure/Process/SupervisedCommand.js";
import { assertAllowedRoot } from "../Policy/PathGuard.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { buildSafeEnv, resolveCommandExecutable, sanitizeText } from "../Infrastructure/Process/ProcessRuntime.js";
import { buildConsoleMutationToolRegistration, buildConsoleToolRegistration, textResult } from "./common.js";

const allowedActions = ["status", "start", "stop", "restart"] as const;
const allowedHosts = ["127.0.0.1", "localhost"] as const;

type LocalPhpAction = typeof allowedActions[number];
type LocalPhpHost = typeof allowedHosts[number];

type LocalPhpState = {
  tool: "local-php-server";
  pid: number;
  host: LocalPhpHost;
  port: number;
  cwd: string;
  publicDir: string;
  router: string;
  healthPath: string;
  startedAt: string;
  url: string;
  stdoutLog: string;
  stderrLog: string;
};

type ProcessStatus = {
  pid: number | null;
  running: boolean;
  source: "state" | "none";
  statePath: string;
};

type HttpProbe = {
  ok: boolean;
  url: string;
  statusCode: number | null;
  body: string;
  error: string | null;
};

type CommandResult = Awaited<ReturnType<typeof runSupervisedCommand>>;

export function registerLocalPhpServerTool(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  const readRegistration = buildConsoleToolRegistration(authConfig);
  const mutationRegistration = buildConsoleMutationToolRegistration(authConfig);

  server.registerTool(
    "console.read_.runtime.php.server.status",
    {
      description: "Inspect a managed loopback PHP built-in server for a Symfony/public workspace.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        port: z.number().int().min(1024).max(65535).optional(),
        host: z.enum(allowedHosts).optional(),
        publicDir: z.string().min(1).optional(),
        router: z.string().min(1).optional(),
        healthPath: z.string().min(1).optional(),
        waitMs: z.number().int().min(1000).max(30000).optional(),
      }).strict(),
      ...readRegistration,
    },
    async (input) => textResult(await runLocalPhpServer(policy, { ...input, action: "status" }))
  );

  server.registerTool(
    "console.write.runtime.php.server.restart",
    {
      description: "Restart a managed loopback PHP built-in server for a Symfony/public workspace.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        port: z.number().int().min(1024).max(65535).optional(),
        host: z.enum(allowedHosts).optional(),
        publicDir: z.string().min(1).optional(),
        router: z.string().min(1).optional(),
        healthPath: z.string().min(1).optional(),
        waitMs: z.number().int().min(1000).max(30000).optional(),
      }).strict(),
      ...mutationRegistration,
    },
    async (input) => textResult(await runLocalPhpServer(policy, { ...input, action: "restart" }))
  );
}

type LocalPhpInput = {
  workspacePath: string;
  action: LocalPhpAction;
  port?: number;
  host?: LocalPhpHost;
  publicDir?: string;
  router?: string;
  healthPath?: string;
  waitMs?: number;
};

async function runLocalPhpServer(policy: ConsolePolicy, input: LocalPhpInput): Promise<Record<string, unknown>> {
  const workspace = assertAllowedRoot(input.workspacePath, policy.allowedRoots);
  const port = input.port ?? 8000;
  const host = input.host ?? "127.0.0.1";
  const publicDir = normalizeRepoPath(input.publicDir ?? "public");
  const router = normalizeRepoPath(input.router ?? "public/index.php");
  const healthPath = normalizeHealthPath(input.healthPath ?? "/");
  const waitMs = input.waitMs ?? 8000;
  const resolved = resolveSymfonyServerPaths(workspace, publicDir, router);
  const statePath = getStatePath(workspace, port);

  if (input.action === "status") {
    return await buildStatus(workspace, statePath, host, port, healthPath);
  }

  if (input.action === "stop") {
    return await stopManagedServer(workspace, statePath, host, port, healthPath);
  }

  if (input.action === "restart") {
    const stopped = await stopManagedServer(workspace, statePath, host, port, healthPath);
    const started = await startManagedServer(workspace, statePath, host, port, resolved.publicDir, resolved.router, healthPath, waitMs);
    return { ok: Boolean(started.ok), action: input.action, stopped, started };
  }

  return await startManagedServer(workspace, statePath, host, port, resolved.publicDir, resolved.router, healthPath, waitMs);
}

function resolveSymfonyServerPaths(workspace: string, publicDir: string, router: string): { publicDir: string; router: string } {
  const publicDirPath = path.resolve(workspace, publicDir);
  const routerPath = path.resolve(workspace, router);
  assertInsideWorkspace(workspace, publicDirPath);
  assertInsideWorkspace(workspace, routerPath);
  if (!existsSync(publicDirPath)) {
    throw new Error(`Public directory does not exist: ${publicDir}`);
  }
  if (!existsSync(routerPath)) {
    throw new Error(`Router file does not exist: ${router}`);
  }
  return { publicDir, router };
}

function assertInsideWorkspace(workspace: string, absolutePath: string): void {
  const relative = path.relative(workspace, absolutePath).replaceAll("\\", "/");
  if (!relative || relative.startsWith("../") || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("Resolved path escaped workspace boundary.");
  }
}

async function buildStatus(workspace: string, statePath: string, host: LocalPhpHost, port: number, healthPath: string): Promise<Record<string, unknown>> {
  const state = await readState(statePath);
  const managed = await getManagedProcessStatus(statePath, state);
  const probe = await probeHttp(buildUrl(host, port, healthPath), 3000);
  return {
    ok: managed.running && probe.ok,
    action: "status",
    workspace,
    host,
    port,
    managed,
    probe,
    state: state ? sanitizeState(state) : null,
  };
}

async function startManagedServer(workspace: string, statePath: string, host: LocalPhpHost, port: number, publicDir: string, router: string, healthPath: string, waitMs: number): Promise<Record<string, unknown>> {
  const existingState = await readState(statePath);
  const existingManaged = await getManagedProcessStatus(statePath, existingState);
  const existingProbe = await probeHttp(buildUrl(host, port, healthPath), 3000);
  if (existingManaged.running && existingProbe.ok) {
    return {
      ok: true,
      action: "start",
      alreadyRunning: true,
      workspace,
      host,
      port,
      managed: existingManaged,
      probe: existingProbe,
      state: existingState ? sanitizeState(existingState) : null,
    };
  }

  const runtimeDir = path.dirname(statePath);
  const logDir = path.join(runtimeDir, "local-php-server-log");
  await mkdir(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stdoutLog = path.join(logDir, `${port}-${stamp}-stdout.log`);
  const stderrLog = path.join(logDir, `${port}-${stamp}-stderr.log`);
  const outFd = openSync(stdoutLog, "a");
  const errFd = openSync(stderrLog, "a");
  const startedAt = new Date().toISOString();
  const php = resolveCommandExecutable("php").replaceAll("\"", "");

  try {
    const child = spawn(php, ["-S", `${host}:${port}`, "-t", publicDir, router], {
      cwd: workspace,
      detached: true,
      windowsHide: true,
      env: buildSafeEnv(),
      stdio: ["ignore", outFd, errFd],
    });

    child.unref();
    const state: LocalPhpState = {
      tool: "local-php-server",
      pid: child.pid ?? 0,
      host,
      port,
      cwd: workspace,
      publicDir,
      router,
      healthPath,
      startedAt,
      url: buildUrl(host, port, healthPath),
      stdoutLog,
      stderrLog,
    };
    await writeState(statePath, state);

    const probe = await waitForHttp(state.url, waitMs);
    const managed = await getManagedProcessStatus(statePath, state);
    return {
      ok: managed.running && probe.ok,
      action: "start",
      alreadyRunning: false,
      workspace,
      host,
      port,
      publicDir,
      router,
      managed,
      probe,
      state: sanitizeState(state),
    };
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
}

async function stopManagedServer(workspace: string, statePath: string, host: LocalPhpHost, port: number, healthPath: string): Promise<Record<string, unknown>> {
  const state = await readState(statePath);
  const before = await getManagedProcessStatus(statePath, state);
  if (!state || !before.running || state.pid <= 0) {
    const probe = await probeHttp(buildUrl(host, port, healthPath), 3000);
    return {
      ok: !probe.ok,
      action: "stop",
      stopped: false,
      reason: state ? "managed_process_not_running" : "managed_state_not_found",
      workspace,
      host,
      port,
      managed: before,
      probe,
      state: state ? sanitizeState(state) : null,
    };
  }

  const taskkill = await runSupervisedCommand(workspace, "taskkill", ["/PID", String(state.pid), "/T", "/F"], 30000, 1024 * 1024);
  await rm(statePath, { force: true });
  await sleep(1000);
  const probe = await probeHttp(buildUrl(state.host, state.port, state.healthPath), 3000);
  return {
    ok: taskkill.ok || !probe.ok,
    action: "stop",
    stopped: taskkill.ok,
    workspace,
    host: state.host,
    port: state.port,
    taskkill: sanitizeCommandResult(taskkill),
    managedBefore: before,
    probe,
    state: sanitizeState(state),
  };
}

function getStatePath(workspace: string, port: number): string {
  return path.join(workspace, ".console-mcp", `local-php-server-${port}.json`);
}

async function readState(statePath: string): Promise<LocalPhpState | null> {
  if (!existsSync(statePath)) {
    return null;
  }
  const parsed = JSON.parse(await readFile(statePath, "utf8")) as Partial<LocalPhpState>;
  if (parsed.tool !== "local-php-server" || typeof parsed.pid !== "number") {
    return null;
  }
  return parsed as LocalPhpState;
}

async function writeState(statePath: string, state: LocalPhpState): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function getManagedProcessStatus(statePath: string, state: LocalPhpState | null): Promise<ProcessStatus> {
  if (!state || state.pid <= 0) {
    return { pid: null, running: false, source: "none", statePath };
  }
  return { pid: state.pid, running: await isProcessRunning(state.pid), source: "state", statePath };
}

async function isProcessRunning(pid: number): Promise<boolean> {
  const result = await runSupervisedCommand(process.cwd(), "tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], 30000, 1024 * 1024);
  return result.ok && result.stdout.includes(`"${pid}"`);
}

async function waitForHttp(url: string, waitMs: number): Promise<HttpProbe> {
  const started = Date.now();
  let last = await probeHttp(url, 3000);
  while (!last.ok && Date.now() - started < waitMs) {
    await sleep(500);
    last = await probeHttp(url, 3000);
  }
  return last;
}

function probeHttp(url: string, timeoutMs: number): Promise<HttpProbe> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const req = httpRequest(url, { method: "GET", timeout: timeoutMs, headers: { Accept: "text/html,application/json,text/plain,*/*;q=0.5", "User-Agent": "console-mcp-local-php-server/1.0" } }, (res) => {
      res.on("data", (chunk: Buffer | string) => {
        if (chunks.reduce((sum, item) => sum + item.length, 0) < 8192) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
      });
      res.on("end", () => {
        const body = truncateOutput(sanitizeText(Buffer.concat(chunks).toString("utf8")), 8192).text;
        const statusCode = res.statusCode ?? null;
        resolve({ ok: statusCode !== null && statusCode >= 200 && statusCode < 500, url, statusCode, body, error: null });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`Request timed out after ${timeoutMs} ms.`)));
    req.on("error", (error) => resolve({ ok: false, url, statusCode: null, body: "", error: error instanceof Error ? error.message : String(error) }));
    req.end();
  });
}

function buildUrl(host: LocalPhpHost, port: number, healthPath: string): string {
  return `http://${host}:${port}${healthPath}`;
}

function normalizeHealthPath(input: string): string {
  const value = input.trim();
  if (!value.startsWith("/") || value.includes("..")) {
    throw new Error("Health path must be an absolute local URL path without '..'.");
  }
  return value;
}

function sanitizeState(state: LocalPhpState): Record<string, unknown> {
  return {
    pid: state.pid,
    host: state.host,
    port: state.port,
    cwd: state.cwd,
    publicDir: state.publicDir,
    router: state.router,
    healthPath: state.healthPath,
    startedAt: state.startedAt,
    url: state.url,
    stdoutLog: state.stdoutLog,
    stderrLog: state.stderrLog,
  };
}

function sanitizeCommandResult(result: CommandResult): Record<string, unknown> {
  const stdout = truncateOutput(result.stdout);
  const stderr = truncateOutput(result.stderr);
  return { ok: result.ok, command: result.command, args: result.args, cwd: result.cwd, exitCode: result.exitCode, stdout: stdout.text, stdoutTruncated: stdout.truncated, stderr: stderr.text, stderrTruncated: stderr.truncated };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

