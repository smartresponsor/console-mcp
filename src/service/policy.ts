import { readFile } from "node:fs/promises";
import path from "node:path";

export type AllowedRootPolicy = {
  defaultRoot: string;
  allowedRoots: string[];
};

export type DeniedPathPolicy = {
  denyBasenames: string[];
  denyExtensions: string[];
  denyPathFragments: string[];
  allowlist: string[];
};

export type AllowedCheck = {
  command: string;
  args: string[];
  cwdMode: "workspaceRoot";
  timeoutMs: number;
};

export type AllowedCheckPolicy = {
  defaultTimeoutMs: number;
  checks: Record<string, AllowedCheck>;
};

export type ConsolePolicy = {
  serverName: string;
  version: string;
  transport: "streamable-http";
  endpoint: string;
  host: string;
  port: number;
  workspaceRoot: string;
  allowedRoots: string[];
  deniedPath: DeniedPathPolicy;
  allowedChecks: AllowedCheckPolicy;
  maxFileBytes: number;
  maxSearchResults: number;
  maxStatusLines: number;
  transcriptDir: string;
  loaded: boolean;
};

export async function loadConsolePolicy(baseDir: string): Promise<ConsolePolicy> {
  const allowedRoot = await readJson<AllowedRootPolicy>(path.join(baseDir, "policy", "allowed-root.json"));
  const deniedPath = await readJson<DeniedPathPolicy>(path.join(baseDir, "policy", "denied-path.json"));
  const allowedChecks = await readJson<AllowedCheckPolicy>(path.join(baseDir, "policy", "allowed-check.json"));

  const workspaceRoot = normalizePath(process.env.CONSOLE_MCP_WORKSPACE_ROOT ?? allowedRoot.defaultRoot);
  const host = process.env.CONSOLE_MCP_HOST?.trim() || "127.0.0.1";
  const port = parsePort(process.env.CONSOLE_MCP_PORT) ?? 3333;
  const maxFileBytes = parsePositiveInt(process.env.CONSOLE_MCP_MAX_FILE_BYTES) ?? 262144;
  const maxSearchResults = parsePositiveInt(process.env.CONSOLE_MCP_MAX_SEARCH_RESULTS) ?? 50;
  const maxStatusLines = parsePositiveInt(process.env.CONSOLE_MCP_MAX_STATUS_LINES) ?? 200;
  const transcriptDir = normalizePath(process.env.CONSOLE_MCP_TRANSCRIPT_DIR ?? path.join(baseDir, "var", "transcript"));
  const configuredAllowedRoots = [allowedRoot.defaultRoot, ...allowedRoot.allowedRoots];
  const allowedRoots = appendExtraAllowedRoots(configuredAllowedRoots).map(normalizePath);

  return {
    serverName: "console-mcp",
    version: "1.0.0",
    transport: "streamable-http",
    endpoint: "/mcp",
    host,
    port,
    workspaceRoot,
    allowedRoots,
    deniedPath,
    allowedChecks,
    maxFileBytes,
    maxSearchResults,
    maxStatusLines,
    transcriptDir,
    loaded: true,
  };
}

function appendExtraAllowedRoots(allowedRoots: string[]): string[] {
  const extraRoots = parsePathList(process.env.CONSOLE_MCP_EXTRA_ALLOWED_ROOTS);
  return [...allowedRoots, ...extraRoots];
}

function parsePathList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

async function readJson<T>(filePath: string): Promise<T> {
  const text = await readFile(filePath, "utf8");
  return JSON.parse(text) as T;
}

function parsePort(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : null;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function normalizePath(input: string): string {
  return path.resolve(input);
}
