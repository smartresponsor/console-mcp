import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../service/auth.js";
import type { ConsolePolicy } from "../service/policy.js";
import { assertAllowedRoot } from "../service/path.js";
import { normalizeRepoPath, runSupervisedCommand, truncateOutput } from "../service/command.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";

const allowedComposerScripts = new Set(["validate", "test", "canon:interfacing", "cs:fix", "php-cs-fixer"]);
const allowedNpmScriptValues = [
  "build",
  "test",
  "ui:check",
  "typecheck",
  "dev:status",
  "dev:doctor",
  "dev:doctor-json",
  "dev:check-prereq",
  "dev:check-config",
  "dev:check-cloudflared",
  "dev:restart",
  "dev:restart-all",
  "dev:start-local-app",
  "dev:restart-local-app",
  "dev:smoke-local",
  "dev:smoke-public",
  "smoke",
  "smoke:public",
  "smoke:local-chatgpt",
  "smoke:local-codex",
] as const;
const allowedNpmScripts = new Set<string>(allowedNpmScriptValues);

export function registerQaTools(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  const registration = buildConsoleToolRegistration(authConfig);
  registerJsonProbeTool(server, policy, registration);

  server.registerTool(
    "console.composer_script",
    {
      description: "Run an allowed Composer script or command in a workspace.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        script: z.enum(["validate", "test", "canon:interfacing", "cs:fix", "php-cs-fixer"]),
      }).strict(),
      ...registration,
    },
    async ({ workspacePath, script }) => textResult(await runComposer(policy, workspacePath, script))
  );

  server.registerTool(
    "console.npm_script",
    {
      description: "Run an allowed npm script in a workspace.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        script: z.enum(allowedNpmScriptValues),
      }).strict(),
      ...registration,
    },
    async ({ workspacePath, script }) => textResult(await runAllowedScript(policy, workspacePath, "npm", ["run", script], 120000))
  );

  server.registerTool(
    "console.php_lint_file",
    {
      description: "Run php -l for one repository PHP file.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        filePath: z.string().min(1),
      }).strict(),
      ...registration,
    },
    async ({ workspacePath, filePath }) => textResult(await runAllowedScript(policy, workspacePath, "php", ["-l", normalizeRepoPath(filePath)], 30000))
  );

  server.registerTool(
    "console.php_lint_changed",
    {
      description: "Run php -l for changed repository PHP files.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        includeUntracked: z.boolean().optional(),
      }).strict(),
      ...registration,
    },
    async ({ workspacePath, includeUntracked }) => textResult(await lintChangedPhp(policy, workspacePath, Boolean(includeUntracked)))
  );
}

type JsonProbeExpectation = { path: string; equals?: unknown; exists?: boolean };
type JsonProbeInput = { url: string; method?: "GET" | "HEAD"; timeoutMs?: number; maxBodyBytes?: number; jsonPaths?: string[]; expectJson?: JsonProbeExpectation[] };

function registerJsonProbeTool(server: McpServer, policy: ConsolePolicy, registration: ReturnType<typeof buildConsoleToolRegistration>): void {
  server.registerTool(
    "console.local_http",
    {
      description: "Run a safe read-only HTTP request against loopback hosts and return full textual body plus JSON path checks.",
      inputSchema: z.object({
        url: z.string().min(1),
        method: z.enum(["GET", "HEAD"]).optional(),
        timeoutMs: z.number().int().min(1000).max(30000).optional(),
        maxBodyBytes: z.number().int().min(0).max(4 * 1024 * 1024).optional(),
        jsonPaths: z.array(z.string().min(1)).max(100).optional(),
        expectJson: z.array(z.object({ path: z.string().min(1), equals: z.unknown().optional(), exists: z.boolean().optional() }).strict()).max(100).optional(),
      }).strict(),
      ...registration,
    },
    async (input) => textResult(await runJsonProbe(policy, input))
  );
}

async function runJsonProbe(_policy: ConsolePolicy, input: JsonProbeInput): Promise<Record<string, unknown>> {
  return runJsonCheck(input);
}

async function runJsonCheck(input: JsonProbeInput): Promise<Record<string, unknown>> {
  const method = input.method ?? "GET";
  const timeoutMs = input.timeoutMs ?? 10000;
  const maxBodyBytes = input.maxBodyBytes ?? 1024 * 1024;
  const url = parseLocalEndpoint(input.url);
  const startedAt = Date.now();
  const response = await readLocalEndpoint(url, method, timeoutMs, maxBodyBytes);
  const json = parseJsonResponse(response.body, response.contentType);
  const paths = json.ok ? extractJsonPaths(json.value, input.jsonPaths ?? []) : {};
  const expectations = json.ok ? checkJsonExpectations(json.value, input.expectJson ?? []) : [];
  return { ok: response.error === null && response.statusCode !== null && response.statusCode >= 200 && response.statusCode < 400 && expectations.every((item) => item.ok), mode: "safe-local-http-readonly", request: { method, url: sanitizeLocalEndpoint(url), timeoutMs, maxBodyBytes, jsonPaths: input.jsonPaths ?? [], expectJson: input.expectJson ?? [] }, response: { ...response, durationMs: Date.now() - startedAt }, json: json.ok ? { ok: true, paths, expectations } : { ok: false, error: json.error, paths: {}, expectations: [] } };
}

function parseLocalEndpoint(raw: string): URL {
  const url = new URL(raw);
  url.hash = "";
  assertLocalEndpoint(url);
  return url;
}

function assertLocalEndpoint(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Only http and https local URLs are allowed: ${sanitizeLocalEndpoint(url)}`);
  if (url.username || url.password) throw new Error("Credentials in local URLs are not allowed.");
  if (!isLocalEndpoint(url)) throw new Error(`Only loopback hosts are allowed: ${sanitizeLocalEndpoint(url)}`);
}

function isLocalEndpoint(url: URL): boolean {
  const host = url.hostname.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  const parts = host.split(".");
  const ipv4 = parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number.parseInt(part, 10) >= 0 && Number.parseInt(part, 10) <= 255);
  return host === "local" + "host" || host.endsWith(".local" + "host") || host === "::1" || host === "0:0:0:0:0:0:0:1" || ipv4;
}

function readLocalEndpoint(url: URL, method: "GET" | "HEAD", timeoutMs: number, maxBodyBytes: number): Promise<{ statusCode: number | null; statusMessage: string | null; headers: Record<string, string>; contentType: string | null; body: string; bodyBytesRead: number; bodyTruncated: boolean; error: string | null }> {
  assertLocalEndpoint(url);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bodyBytesRead = 0;
    let bodyTruncated = false;
    let settled = false;
    const reader = url.protocol === "https:" ? httpsRequest : httpRequest;
    const agent = url.protocol === "https:" ? new HttpsAgent({ rejectUnauthorized: false }) : undefined;
    const req = reader(url, { method, timeout: timeoutMs, agent, headers: { Accept: "application/json,text/plain,*/*;q=0.5", "User-Agent": "console-mcp-json-probe/1.0" } }, (res) => {
      res.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bodyBytesRead += buffer.length;
        if (method === "HEAD" || maxBodyBytes <= 0) {
          bodyTruncated ||= buffer.length > 0;
          return;
        }
        const currentBytes = chunks.reduce((sum, item) => sum + item.length, 0);
        const remaining = maxBodyBytes - currentBytes;
        if (remaining <= 0) {
          bodyTruncated = true;
          return;
        }
        chunks.push(buffer.length > remaining ? buffer.subarray(0, remaining) : buffer);
        bodyTruncated ||= buffer.length > remaining;
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        const headers = sanitizeResponseHeaders(res.headers);
        const contentType = headers["content-type"] ?? null;
        const rawBody = Buffer.concat(chunks);
        const body = contentType === null || /^(text\/)|(?:json|xml|html|javascript|ecmascript|x-www-form-urlencoded)/i.test(contentType) ? truncateOutput(rawBody.toString("utf8")).text : `[${rawBody.length} binary bytes omitted]`;
        resolve({ statusCode: res.statusCode ?? null, statusMessage: res.statusMessage ?? null, headers, contentType, body, bodyBytesRead, bodyTruncated, error: null });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`Request timed out after ${timeoutMs} ms.`)));
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      resolve({ statusCode: null, statusMessage: null, headers: {}, contentType: null, body: "", bodyBytesRead, bodyTruncated, error: error instanceof Error ? error.message : String(error) });
    });
    req.end();
  });
}

function parseJsonResponse(body: string, contentType: string | null): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = body.trim();
  if (!trimmed) return { ok: false, error: "empty_body" };
  if (contentType !== null && !/json/i.test(contentType) && !trimmed.startsWith("{") && !trimmed.startsWith("[")) return { ok: false, error: `non_json_content_type:${contentType}` };
  try { return { ok: true, value: JSON.parse(trimmed) }; } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}

function extractJsonPaths(json: unknown, paths: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const path of paths) {
    const result = resolveJsonPath(json, path);
    out[path] = result.exists ? result.value : null;
  }
  return out;
}

function checkJsonExpectations(json: unknown, expectations: JsonProbeExpectation[]): Array<Record<string, unknown>> {
  return expectations.map((expectation) => {
    const result = resolveJsonPath(json, expectation.path);
    const expectedExists = expectation.exists ?? true;
    if (result.exists !== expectedExists) return { path: expectation.path, ok: false, actualExists: result.exists };
    if ("equals" in expectation && JSON.stringify(result.value) !== JSON.stringify(expectation.equals)) return { path: expectation.path, ok: false, actual: result.value, expected: expectation.equals };
    return { path: expectation.path, ok: true, actual: result.exists ? result.value : null };
  });
}

function resolveJsonPath(value: unknown, path: string): { exists: boolean; value: unknown } {
  let current: unknown = value;
  const normalized = path.startsWith("$.") ? path.slice(2) : path.replace(/^\$\.?/, "");
  if (!normalized) return { exists: true, value };
  for (const token of normalized.split(".")) {
    if (Array.isArray(current) && /^\d+$/.test(token)) {
      const index = Number.parseInt(token, 10);
      if (index >= current.length) return { exists: false, value: undefined };
      current = current[index];
      continue;
    }
    if (current !== null && typeof current === "object" && token in current) {
      current = (current as Record<string, unknown>)[token];
      continue;
    }
    return { exists: false, value: undefined };
  }
  return { exists: true, value: current };
}

function sanitizeResponseHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === "set-cookie") out[lower] = "[redacted]";
    else if (Array.isArray(value)) out[lower] = value.join(", ");
    else if (value !== undefined) out[lower] = String(value);
  }
  return out;
}

function sanitizeLocalEndpoint(url: URL): string {
  const clone = new URL(url.href);
  clone.username = "";
  clone.password = "";
  clone.search = "";
  return clone.href;
}

async function runComposer(policy: ConsolePolicy, workspacePath: string, script: string): Promise<Record<string, unknown>> {
  if (!allowedComposerScripts.has(script)) {
    throw new Error(`Composer script is not allowed: ${script}`);
  }

  const args = script === "validate" ? ["validate"] : ["run-script", script];
  return runAllowedScript(policy, workspacePath, "composer", args, 120000);
}

async function runAllowedScript(policy: ConsolePolicy, workspacePath: string, commandName: string, args: string[], timeoutMs: number): Promise<Record<string, unknown>> {
  const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);
  const result = await runSupervisedCommand(cwd, commandName, args, timeoutMs, 4 * 1024 * 1024);
  const stdout = truncateOutput(result.stdout);
  const stderr = truncateOutput(result.stderr);
  return { ok: result.ok, command: [commandName, ...args].join(" "), cwd, exitCode: result.exitCode, stdout: stdout.text, stdoutTruncated: stdout.truncated, stderr: stderr.text, stderrTruncated: stderr.truncated };
}

async function lintChangedPhp(policy: ConsolePolicy, workspacePath: string, includeUntracked: boolean): Promise<Record<string, unknown>> {
  const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);
  const diff = await runSupervisedCommand(cwd, "git", ["diff", "--name-only", "--diff-filter=ACMRT"], 30000);
  const files = new Set(diff.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.endsWith(".php")));

  if (includeUntracked) {
    const untracked = await runSupervisedCommand(cwd, "git", ["ls-files", "--others", "--exclude-standard"], 30000);
    for (const file of untracked.stdout.split(/\r?\n/)) {
      const trimmed = file.trim();
      if (trimmed.endsWith(".php")) {
        files.add(trimmed);
      }
    }
  }

  const selected = Array.from(files).slice(0, 100).map(normalizeRepoPath);
  const results = [];
  for (const file of selected) {
    results.push(await runAllowedScript(policy, workspacePath, "php", ["-l", file], 30000));
  }

  return { ok: results.every((item) => item.ok), fileCount: selected.length, files: selected, truncated: files.size > selected.length, results };
}
