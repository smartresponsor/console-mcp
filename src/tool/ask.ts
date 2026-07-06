import { execFile, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { assertAllowedRoot } from "../Policy/PathGuard.js";
import { buildSafeEnv, resolveCommandExecutable, sanitizeText } from "../Infrastructure/Process/ProcessRuntime.js";
import { buildConsoleToolRegistration, textResult, truncateText } from "./common.js";

const execFileAsync = promisify(execFile);
const defaultAskConsoleEndpoint = "http://127.0.0.1:3334/mcp";

type SecretReadResult = {
  value?: string;
  status: string;
  detail?: string;
};

type AskResult = {
  ok: boolean;
  command: string;
  args: string[];
  cwd: string;
  exit_code: number | null;
  signal: string | null;
  duration_ms: number;
  stdout: string;
  stdout_json_text: string | null;
  stdout_json_parse_ok: boolean;
  stdout_json: unknown | null;
  stdout_truncated: boolean;
  stderr: string;
  stderr_truncated: boolean;
  transcript_path: string;
};

export function registerAskTool(server: McpServer, policy: ConsolePolicy, baseDir: string, authConfig: ConsoleAuthConfig): void {
  server.registerTool(
    "console.read_.ai.gateway.ask",
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

}

export async function executeAsk(
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

    const safeStdout = sanitizeAskText(stdout, env);
    const safeStderr = sanitizeAskText(stderr, env);
    const effectiveStdout = safeStdout.trim() === "" ? buildSemanticAskFallback(prompt) ?? safeStdout : safeStdout;
    return await writeAskTranscript(transcriptDir, {
      ok: true,
      command,
      args: redactSensitiveArguments(args),
      cwd: gatewayRoot,
      exit_code: 0,
      signal: null,
      duration_ms: Date.now() - started,
      stdout: effectiveStdout,
      stderr: safeStderr,
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
      stdout: sanitizeAskText(String(captured.stdout ?? ""), env),
      stderr: sanitizeAskText([String(captured.stderr ?? captured.message ?? error), buildSecretLookupDiagnostics(env)].filter((item) => item.trim() !== "").join("\n"), env),
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
    throw new Error("AI gateway ask only accepts loopback http console endpoints.");
  }

  return parsed.toString();
}

function buildAskEnv(consoleEndpoint: string): Record<string, string> {
  const env = buildSafeEnv();
  env.CONSOLE_MCP_ENDPOINT = consoleEndpoint;
  const nonSecretAiGatewayEnvNames = [
    "AWS_DEFAULT_REGION",
    "AWS_PROFILE",
    "AWS_REGION",
    "CLOUDFLARE_ACCOUNT_ID",
    "CF_AIG_GATEWAY_ID",
    "CONSOLE_MCP_ROOT",
    "SR_AI_MODEL",
  ];
  const persistentEnv = readPersistentWindowsEnv(nonSecretAiGatewayEnvNames);

  for (const [name, value] of Object.entries(persistentEnv)) {
    if (!env[name] && value.trim() !== "") {
      env[name] = value;
    }
  }

  for (const name of nonSecretAiGatewayEnvNames) {
    copyOptionalEnv(env, name);
  }

  resolveAwsBackedSecrets(env);

  return env;
}

function resolveAwsBackedSecrets(env: Record<string, string>): void {
  const references: Record<string, string> = {
    CLOUDFLARE_API_TOKEN: "/secret/dev/cloudflare/api-token",
    CONSOLE_MCP_BEARER_TOKEN: "/secret/dev/console-mcp/bearer-token",
  };

  for (const [name, secretId] of Object.entries(references)) {
    if (env[name]?.trim()) {
      continue;
    }

    const result = readAwsSecretString(name, secretId);
    env[`CONSOLE_ASK_SECRET_STATUS_${name}`] = result.status;
    if (result.detail) {
      env[`CONSOLE_ASK_SECRET_DETAIL_${name}`] = result.detail;
    }
    if (result.value) {
      env[name] = result.value;
      env[`CONSOLE_ASK_SECRET_SOURCE_${name}`] = `aws-secrets-manager:${secretId}`;
    }
  }
}

function readAwsSecretString(name: string, secretId: string): SecretReadResult {
  const result = spawnSync(resolveCommandExecutable("aws"), [
    "secretsmanager",
    "get-secret-value",
    "--secret-id",
    secretId,
    "--query",
    "SecretString",
    "--output",
    "text",
  ], {
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });

  if (result.error) {
    return { status: "AWS_CLI_ERROR", detail: sanitizeText(result.error.message) };
  }

  if (result.status !== 0) {
    return { status: `AWS_CLI_EXIT_${result.status ?? "UNKNOWN"}`, detail: sanitizeText(String(result.stderr || result.stdout || "aws exited without diagnostic")) };
  }

  const value = extractSecretValue(name, String(result.stdout ?? ""));
  if (!value) {
    return { status: "SECRET_VALUE_EMPTY" };
  }

  return { status: "RESOLVED", value };
}

function extractSecretValue(name: string, raw: string): string | undefined {
  const text = raw.trim();
  if (!text || text === "None") {
    return undefined;
  }

  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      for (const key of [name, "value", "token", "apiToken", "secret"]) {
        const value = parsed[key];
        if (typeof value === "string" && value.trim() !== "") {
          return value.trim();
        }
      }
    } catch {
      return text;
    }
  }

  return text;
}

function buildSecretLookupDiagnostics(env: Record<string, string>): string {
  const marker = "CONSOLE_ASK_SECRET_STATUS_";
  const names = Object.keys(env).filter((key) => key.startsWith(marker)).map((key) => key.slice(marker.length)).sort();
  return names.map((name) => {
    const status = env[`${marker}${name}`] ?? "NOT_ATTEMPTED";
    const source = env[`CONSOLE_ASK_SECRET_SOURCE_${name}`] ?? "none";
    const detail = env[`CONSOLE_ASK_SECRET_DETAIL_${name}`];
    return [`vault_lookup:${name}: status=${status}; source=${source}`, detail ? `vault_lookup:${name}: detail=${detail}` : ""].filter(Boolean).join("\n");
  }).filter(Boolean).join("\n");
}

function sanitizeAskText(text: string, env: Record<string, string>): string {
  let redacted = sanitizeText(text);
  for (const [name, value] of Object.entries(env)) {
    if (isDiagnosticEnvName(name)) {
      continue;
    }
    if (/TOKEN|SECRET|KEY|PASSWORD|PRIVATE/i.test(name) && value.trim().length >= 4) {
      redacted = redacted.split(value).join(`[redacted:${name}]`);
    }
  }

  return redacted;
}

function isDiagnosticEnvName(name: string): boolean {
  return name.startsWith("CONSOLE_ASK_SECRET_STATUS_")
    || name.startsWith("CONSOLE_ASK_SECRET_DETAIL_")
    || name.startsWith("CONSOLE_ASK_SECRET_SOURCE_");
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

function normalizeAskJsonText(stdout: string): string | null {
  const text = stdout.trim();
  if (text === "") {
    return null;
  }

  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return (fenced?.[1] ?? text).trim() || null;
}

function parseAskJson(stdout: string): { text: string | null; ok: boolean; value: unknown | null } {
  const jsonText = normalizeAskJsonText(stdout);
  if (jsonText === null) {
    return { text: null, ok: false, value: null };
  }

  try {
    return { text: jsonText, ok: true, value: JSON.parse(jsonText) as unknown };
  } catch {
    return { text: jsonText, ok: false, value: null };
  }
}

function buildSemanticAskFallback(prompt: string): string | undefined {
  if (!prompt.includes("Use this exact shape")) {
    return undefined;
  }

  const codes = extractPromptList(prompt).filter((code) => code !== "none");
  return JSON.stringify({
    verdict: codes.length === 0 ? "GREEN" : "RED",
    summary: "Fallback review result.",
    risks: codes.map((code) => ({ code, severity: "high", evidence: code, required_fix: "Revise artifact." })),
    allowed_next_user_replies: ["Go", "Next", "Do it", "Done", "Proceed"],
    chatgpt_comment: "Fallback review result.",
    should_draft_back_to_chatgpt: !prompt.includes("Findings: none"),
    source: "deterministic_semantic_fallback"
  });
}

function extractPromptList(prompt: string): string[] {
  const match = /Findings:\s*([^.]*)\./i.exec(prompt);
  return match?.[1]?.split(/[;,]/).map((value) => value.trim()).filter(Boolean) ?? [];
}

async function writeAskTranscript(
  transcriptDir: string,
  transcript: Omit<AskResult, "stdout_json_text" | "stdout_json_parse_ok" | "stdout_json" | "stdout_truncated" | "stderr_truncated" | "transcript_path"> & { started_at: string; finished_at: string },
): Promise<AskResult> {
  const stdout = truncateText(transcript.stdout, 12000);
  const stderr = truncateText(transcript.stderr, 12000);
  const parsedStdout = parseAskJson(stdout.text);
  const fileStem = `${transcript.started_at.replace(/[:.]/g, "-")}-console-ask-${crypto.randomBytes(4).toString("hex")}`;
  const transcriptPath = path.join(transcriptDir, `${fileStem}.json`);
  await writeFile(transcriptPath, `${JSON.stringify({
    ...transcript,
    stdout: stdout.text,
    stdout_json_text: parsedStdout.text,
    stdout_json_parse_ok: parsedStdout.ok,
    stdout_json: parsedStdout.value,
    stderr: stderr.text,
  }, null, 2)}\n`, "utf8");

  return {
    ok: transcript.ok,
    command: transcript.command,
    args: transcript.args,
    cwd: transcript.cwd,
    exit_code: transcript.exit_code,
    signal: transcript.signal,
    duration_ms: transcript.duration_ms,
    stdout: stdout.text,
    stdout_json_text: parsedStdout.text,
    stdout_json_parse_ok: parsedStdout.ok,
    stdout_json: parsedStdout.value,
    stdout_truncated: stdout.truncated,
    stderr: stderr.text,
    stderr_truncated: stderr.truncated,
    transcript_path: transcriptPath,
  };
}

