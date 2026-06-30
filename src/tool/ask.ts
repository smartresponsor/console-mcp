import { execFile, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../service/auth.js";
import type { ConsolePolicy } from "../service/policy.js";
import { assertAllowedRoot } from "../service/path.js";
import { buildSafeEnv, resolveCommandExecutable, sanitizeText } from "../service/process.js";
import { buildConsoleToolRegistration, textResult, truncateText } from "./common.js";

const execFileAsync = promisify(execFile);
const defaultAskConsoleEndpoint = "http://127.0.0.1:3334/mcp";

type AskResult = {
  ok: boolean;
  command: string;
  args: string[];
  cwd: string;
  exit_code: number | null;
  signal: string | null;
  duration_ms: number;
  stdout: string;
  stdout_truncated: boolean;
  stderr: string;
  stderr_truncated: boolean;
  transcript_path: string;
};

export function registerAskTool(server: McpServer, policy: ConsolePolicy, baseDir: string, authConfig: ConsoleAuthConfig): void {
  server.registerTool(
    "console.ask",
    {
      description: "Ask the local AI Gateway advisory route using safe console-mcp context. This tool does not grant write, server, push, or commit permissions.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        prompt: z.string().min(1).max(12000),
        model: z.string().min(1).max(200).optional(),
        maxOutputTokens: z.number().int().min(64).max(6000).default(900),
        temperature: z.number().min(0).max(2).default(0.1),
        timeoutMs: z.number().int().min(5000).max(180000).default(60000),
        raw: z.boolean().default(false),
        consoleEndpoint: z.string().min(1).max(200).optional(),
      }).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async ({ workspacePath, prompt, model, maxOutputTokens, temperature, timeoutMs, raw, consoleEndpoint }) => textResult(await executeAsk(
      policy,
      baseDir,
      workspacePath,
      prompt,
      model,
      maxOutputTokens,
      temperature,
      timeoutMs,
      raw,
      consoleEndpoint,
    ))
  );

  server.registerTool(
    "console.read_.ai.gateway.ask",
    {
      description: "Canonical alias for console.ask.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        prompt: z.string().min(1).max(12000),
        model: z.string().min(1).max(200).optional(),
        maxOutputTokens: z.number().int().min(64).max(6000).default(900),
        temperature: z.number().min(0).max(2).default(0.1),
        timeoutMs: z.number().int().min(5000).max(180000).default(60000),
        raw: z.boolean().default(false),
        consoleEndpoint: z.string().min(1).max(200).optional(),
      }).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async ({ workspacePath, prompt, model, maxOutputTokens, temperature, timeoutMs, raw, consoleEndpoint }) => textResult(await executeAsk(
      policy,
      baseDir,
      workspacePath,
      prompt,
      model,
      maxOutputTokens,
      temperature,
      timeoutMs,
      raw,
      consoleEndpoint,
    ))
  );
}

async function executeAsk(
  policy: ConsolePolicy,
  baseDir: string,
  workspacePath: string,
  prompt: string,
  model: string | undefined,
  maxOutputTokens: number,
  temperature: number,
  timeoutMs: number,
  raw: boolean,
  consoleEndpoint: string | undefined,
): Promise<AskResult> {
  const workspace = assertAllowedRoot(workspacePath, policy.allowedRoots);
  const gatewayRoot = path.resolve(baseDir, "..", "aigateway");
  const askScript = path.join(gatewayRoot, "ask.ps1");

  if (!existsSync(askScript)) {
    throw new Error(`AI Gateway ask.ps1 was not found: ${askScript}`);
  }

  const endpoint = resolveConsoleEndpoint(consoleEndpoint, policy);
  const command = resolveCommandExecutable("pwsh");
  const args = buildAskArguments(askScript, prompt, workspace, model, maxOutputTokens, temperature, raw, endpoint);
  const env = buildAskEnv(endpoint);
  const startedAt = new Date();
  const started = startedAt.getTime();
  const transcriptDir = path.join(baseDir, "var", "transcript");
  await mkdir(transcriptDir, { recursive: true });

  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: gatewayRoot,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env,
    });

    return await writeAskTranscript(transcriptDir, {
      ok: true,
      command,
      args: redactSensitiveArguments(args),
      cwd: gatewayRoot,
      exit_code: 0,
      signal: null,
      duration_ms: Date.now() - started,
      stdout: sanitizeText(stdout),
      stderr: sanitizeText(stderr),
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
    });
  } catch (error) {
    const captured = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; signal?: string | null; code?: number | null };
    return await writeAskTranscript(transcriptDir, {
      ok: false,
      command,
      args: redactSensitiveArguments(args),
      cwd: gatewayRoot,
      exit_code: typeof captured.code === "number" ? captured.code : null,
      signal: captured.signal ?? null,
      duration_ms: Date.now() - started,
      stdout: sanitizeText(String(captured.stdout ?? "")),
      stderr: sanitizeText(String(captured.stderr ?? captured.message ?? error)),
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
    });
  }
}

function buildAskArguments(
  askScript: string,
  prompt: string,
  workspace: string,
  model: string | undefined,
  maxOutputTokens: number,
  temperature: number,
  raw: boolean,
  consoleEndpoint: string,
): string[] {
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    askScript,
    prompt,
    "-WorkspacePath",
    workspace,
    "-ConsoleMcpEndpoint",
    consoleEndpoint,
    "-MaxOutputTokens",
    maxOutputTokens.toString(),
    "-Temperature",
    temperature.toString(),
  ];

  if (model && model.trim() !== "") {
    args.push("-Model", model.trim());
  }

  if (raw) {
    args.push("-Raw");
  }

  return args;
}

function resolveConsoleEndpoint(input: string | undefined, policy: ConsolePolicy): string {
  const endpoint = input?.trim() || process.env.CONSOLE_ASK_ENDPOINT?.trim() || defaultAskConsoleEndpoint;
  const parsed = new URL(endpoint);
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "http:" || (host !== "127.0.0.1" && host !== "localhost")) {
    throw new Error("console.ask only accepts loopback http console endpoints.");
  }

  return parsed.toString();
}

function buildAskEnv(consoleEndpoint: string): Record<string, string> {
  const env = buildSafeEnv();
  env.CONSOLE_MCP_ENDPOINT = consoleEndpoint;
  const persistentEnv = readPersistentWindowsEnv([
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
    "CF_AIG_GATEWAY_ID",
    "CONSOLE_MCP_BEARER_TOKEN",
    "CONSOLE_MCP_ROOT",
    "SR_AI_MODEL",
  ]);

  for (const [name, value] of Object.entries(persistentEnv)) {
    if (!env[name] && value.trim() !== "") {
      env[name] = value;
    }
  }

  for (const name of Object.keys(persistentEnv)) {
    copyOptionalEnv(env, name);
  }

  return env;
}

function copyOptionalEnv(env: Record<string, string>, name: string): void {
  const value = process.env[name];
  if (typeof value === "string" && value.trim() !== "") {
    env[name] = value;
  }
}

function readPersistentWindowsEnv(names: string[]): Record<string, string> {
  if (process.platform !== "win32") {
    return {};
  }

  const safeNames = names.filter((name) => /^[A-Z0-9_]+$/.test(name));
  if (safeNames.length === 0) {
    return {};
  }

  const script = [
    "$names = @(",
    safeNames.map((name) => `'${name}'`).join(","),
    ")",
    "$result = @{}",
    "foreach ($name in $names) {",
    "  $value = [Environment]::GetEnvironmentVariable($name, 'User')",
    "  if ([string]::IsNullOrWhiteSpace($value)) { $value = [Environment]::GetEnvironmentVariable($name, 'Machine') }",
    "  if (-not [string]::IsNullOrWhiteSpace($value)) { $result[$name] = $value }",
    "}",
    "$result | ConvertTo-Json -Compress",
  ].join("\n");

  const result = spawnSync(resolveCommandExecutable("powershell"), ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });

  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

function redactSensitiveArguments(args: string[]): string[] {
  return args.map((value) => sanitizeText(value));
}

async function writeAskTranscript(
  transcriptDir: string,
  transcript: Omit<AskResult, "stdout_truncated" | "stderr_truncated" | "transcript_path"> & { started_at: string; finished_at: string },
): Promise<AskResult> {
  const stdout = truncateText(transcript.stdout, 12000);
  const stderr = truncateText(transcript.stderr, 12000);
  const fileStem = `${transcript.started_at.replace(/[:.]/g, "-")}-console-ask-${crypto.randomBytes(4).toString("hex")}`;
  const transcriptPath = path.join(transcriptDir, `${fileStem}.json`);
  await writeFile(transcriptPath, `${JSON.stringify({ ...transcript, stdout: stdout.text, stderr: stderr.text }, null, 2)}\n`, "utf8");

  return {
    ok: transcript.ok,
    command: transcript.command,
    args: transcript.args,
    cwd: transcript.cwd,
    exit_code: transcript.exit_code,
    signal: transcript.signal,
    duration_ms: transcript.duration_ms,
    stdout: stdout.text,
    stdout_truncated: stdout.truncated,
    stderr: stderr.text,
    stderr_truncated: stderr.truncated,
    transcript_path: transcriptPath,
  };
}
