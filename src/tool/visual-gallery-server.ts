import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { runSupervisedCommand, truncateOutput } from "../Infrastructure/Process/SupervisedCommand.js";
import { assertAllowedRoot, isWithinRoot } from "../Policy/PathGuard.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { sanitizeText } from "../Infrastructure/Process/ProcessRuntime.js";
import { buildConsoleMutationToolRegistration, buildConsoleToolRegistration, textResult } from "./common.js";

const DEFAULT_PORT = 9477;
const DEFAULT_HOST = "127.0.0.1";

type GalleryState = {
  tool: "visual-gallery-server";
  pid: number;
  host: string;
  port: number;
  artifactRoot: string;
  scriptPath: string;
  startedAt: string;
  healthUrl: string;
  galleryUrl: string;
  stdoutLog: string;
  stderrLog: string;
};

type Probe = {
  ok: boolean;
  url: string;
  statusCode: number | null;
  body: string;
  error: string | null;
};

export function registerVisualGalleryServerTool(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  const readRegistration = buildConsoleToolRegistration(authConfig);
  const mutationRegistration = buildConsoleMutationToolRegistration(authConfig);
  const inputSchema = z.object({
    workspacePath: z.string().min(1),
    port: z.number().int().min(1024).max(65535).optional(),
    host: z.string().min(1).max(64).optional(),
    waitMs: z.number().int().min(1000).max(30000).optional(),
  }).strict();

  server.registerTool(
    "console.read_.runtime.visual_gallery.server.status",
    {
      description: "Inspect the persistent read-only visual artifact gallery server.",
      inputSchema,
      ...readRegistration,
    },
    async (input) => textResult(await runGalleryServer(policy, input, "status")),
  );

  server.registerTool(
    "console.write.runtime.visual_gallery.server.restart",
    {
      description: "Restart the persistent read-only visual artifact gallery server.",
      inputSchema,
      ...mutationRegistration,
    },
    async (input) => textResult(await runGalleryServer(policy, input, "restart")),
  );
}

async function runGalleryServer(
  policy: ConsolePolicy,
  input: { workspacePath: string; port?: number; host?: string; waitMs?: number },
  action: "status" | "restart",
): Promise<Record<string, unknown>> {
  const workspace = assertAllowedRoot(input.workspacePath, policy.allowedRoots);
  const sandboxRoot = resolveSandboxRoot(policy, workspace);
  const artifactRoot = path.join(sandboxRoot, "var");
  const port = input.port ?? DEFAULT_PORT;
  const host = normalizeGalleryHost(input.host ?? DEFAULT_HOST);
  const waitMs = input.waitMs ?? 8000;
  const runtimeDir = path.join(artifactRoot, ".visual-gallery");
  const statePath = path.join(runtimeDir, "server.json");
  const scriptPath = path.resolve(process.cwd(), "tool", "visual-gallery-server.mjs");

  if (action === "status") {
    return await buildStatus(statePath, host, port, artifactRoot);
  }

  const stopped = await stopManagedServer(statePath);
  const started = await startManagedServer(runtimeDir, statePath, host, port, artifactRoot, scriptPath, waitMs);
  return { ok: Boolean(started.ok), action, stopped, started };
}

function resolveSandboxRoot(policy: ConsolePolicy, workspacePath: string): string {
  const matchingRoots = policy.allowedRoots
    .filter((root) => isWithinRoot(workspacePath, root))
    .sort((left, right) => left.length - right.length);
  return matchingRoots[0] ?? workspacePath;
}

function normalizeGalleryHost(host: string): string {
  const value = host.trim().toLowerCase();
  if (value === "127.0.0.1" || value === "localhost") {
    return value;
  }
  if (isTailscaleIpv4(value)) {
    return value;
  }
  throw new Error("Gallery host must be localhost/127.0.0.1 or a Tailscale IPv4 address in 100.64.0.0/10.");
}

function isTailscaleIpv4(host: string): boolean {
  const parts = host.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [first, second] = parts;
  return first === 100 && second >= 64 && second <= 127;
}

async function buildStatus(statePath: string, host: string, port: number, artifactRoot: string): Promise<Record<string, unknown>> {
  const state = await readState(statePath);
  const running = state ? await isProcessRunning(state.pid) : false;
  const effectiveHost = state?.host ?? host;
  const effectivePort = state?.port ?? port;
  const probe = await probeHttp(`http://${effectiveHost}:${effectivePort}/health`, 3000);
  return {
    ok: running && probe.ok,
    action: "status",
    artifactRoot,
    managed: { pid: state?.pid ?? null, running, statePath },
    probe,
    galleryUrl: state?.galleryUrl ?? `http://${effectiveHost}:${effectivePort}/`,
    state,
  };
}

async function startManagedServer(
  runtimeDir: string,
  statePath: string,
  host: string,
  port: number,
  artifactRoot: string,
  scriptPath: string,
  waitMs: number,
): Promise<Record<string, unknown>> {
  if (!existsSync(scriptPath)) {
    throw new Error(`Visual gallery server script is missing: ${scriptPath}`);
  }

  await mkdir(runtimeDir, { recursive: true });
  const existing = await readState(statePath);
  if (existing && await isProcessRunning(existing.pid)) {
    const existingProbe = await probeHttp(existing.healthUrl, 3000);
    if (existingProbe.ok && existing.host === host && existing.port === port && existing.artifactRoot === artifactRoot) {
      return { ok: true, action: "start", alreadyRunning: true, probe: existingProbe, state: existing };
    }
  }

  const logDir = path.join(runtimeDir, "log");
  await mkdir(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stdoutLog = path.join(logDir, `${stamp}-stdout.log`);
  const stderrLog = path.join(logDir, `${stamp}-stderr.log`);
  const outFd = openSync(stdoutLog, "a");
  const errFd = openSync(stderrLog, "a");
  const startedAt = new Date().toISOString();

  try {
    const child = spawn(process.execPath, [scriptPath, "--root", artifactRoot, "--host", host, "--port", String(port)], {
      cwd: process.cwd(),
      detached: true,
      windowsHide: true,
      stdio: ["ignore", outFd, errFd],
    });
    child.unref();

    const state: GalleryState = {
      tool: "visual-gallery-server",
      pid: child.pid ?? 0,
      host,
      port,
      artifactRoot,
      scriptPath,
      startedAt,
      healthUrl: `http://${host}:${port}/health`,
      galleryUrl: `http://${host}:${port}/`,
      stdoutLog,
      stderrLog,
    };
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    const probe = await waitForHttp(state.healthUrl, waitMs);
    return { ok: probe.ok && await isProcessRunning(state.pid), action: "start", alreadyRunning: false, probe, state };
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
}

async function stopManagedServer(statePath: string): Promise<Record<string, unknown>> {
  const state = await readState(statePath);
  if (!state || state.pid <= 0 || !await isProcessRunning(state.pid)) {
    return { ok: true, stopped: false, reason: state ? "managed_process_not_running" : "managed_state_not_found", state };
  }

  const result = await runSupervisedCommand(process.cwd(), "taskkill", ["/PID", String(state.pid), "/T", "/F"], 30000, 1024 * 1024);
  await rm(statePath, { force: true });
  return {
    ok: result.ok,
    stopped: result.ok,
    pid: state.pid,
    stdout: truncateOutput(result.stdout, 2000).text,
    stderr: truncateOutput(result.stderr, 2000).text,
  };
}

async function readState(statePath: string): Promise<GalleryState | null> {
  if (!existsSync(statePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as Partial<GalleryState>;
    if (parsed.tool !== "visual-gallery-server" || typeof parsed.pid !== "number") {
      return null;
    }
    return parsed as GalleryState;
  } catch {
    return null;
  }
}

async function isProcessRunning(pid: number): Promise<boolean> {
  if (pid <= 0) {
    return false;
  }
  const result = await runSupervisedCommand(process.cwd(), "tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], 30000, 1024 * 1024);
  return result.ok && result.stdout.includes(`"${pid}"`);
}

async function waitForHttp(url: string, waitMs: number): Promise<Probe> {
  const started = Date.now();
  let last = await probeHttp(url, 3000);
  while (!last.ok && Date.now() - started < waitMs) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    last = await probeHttp(url, 3000);
  }
  return last;
}

function probeHttp(url: string, timeoutMs: number): Promise<Probe> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const req = httpRequest(url, { method: "GET", timeout: timeoutMs, headers: { Accept: "application/json,text/plain,*/*;q=0.5" } }, (res) => {
      res.on("data", (chunk: Buffer | string) => {
        if (chunks.reduce((sum, item) => sum + item.length, 0) < 8192) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
      });
      res.on("end", () => {
        const statusCode = res.statusCode ?? null;
        resolve({
          ok: statusCode !== null && statusCode >= 200 && statusCode < 400,
          url,
          statusCode,
          body: truncateOutput(sanitizeText(Buffer.concat(chunks).toString("utf8")), 8192).text,
          error: null,
        });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`Request timed out after ${timeoutMs} ms.`)));
    req.on("error", (error) => resolve({ ok: false, url, statusCode: null, body: "", error: error instanceof Error ? error.message : String(error) }));
    req.end();
  });
}
