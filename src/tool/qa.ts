import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { assertAllowedRoot } from "../Policy/PathGuard.js";
import { normalizeRepoPath, runSupervisedCommand, truncateOutput } from "../Infrastructure/Process/SupervisedCommand.js";
import { buildCodeMemoryGraphSearchPlan, buildWorkspaceUmbrellaWarning, isWorkspaceUmbrellaRoot, resolveCompactCodeMemoryScope } from "../service/code-memory-scope.js";
import { buildConsoleMutationToolRegistration, buildConsoleToolRegistration, textResult } from "./common.js";

const explicitlyAllowedComposerScripts = new Set(["validate", "test", "canon:interfacing", "cs:fix", "php-cs-fixer", "memory:scope:resolve", "memory:scope:cache"]);
const safeComposerScriptPrefixes = [
  "test",
  "smoke",
  "report",
  "lint",
  "qa",
  "cs:check",
  "stan",
  "canon",
  "gating",
] as const;
const deniedComposerScriptFragments = [
  "deploy", "release", "publish", "push", "upload", "migrate", "migration:execute",
  "schema:update", "schema:drop", "db:create", "db:drop", "database:create", "database:drop",
  "fixtures:load", "fixture:load", "seed", "seeding", "truncate", "purge", "drop",
  "install", "update", "require", "remove",
] as const;
const safeComposerScriptPattern = /^[A-Za-z0-9_.:-]+$/;
const allowedComposerCommandValues = ["validate", "install", "update", "show", "audit", "outdated", "dump-autoload"] as const;
const composerPackagePattern = /^(?:[a-z0-9_.-]+\/[a-z0-9_.-]+|php|ext-[a-z0-9_.-]+)$/i;
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
  "smoke:admission",
] as const;
const allowedNpmScripts = new Set<string>(allowedNpmScriptValues);

const restartPlanSchema = z.object({ workspacePath: z.string().min(1) }).strict();
const npmDevRestartSchema = z.object({ workspacePath: z.string().min(1), confirmRestart: z.boolean().default(false) }).strict();
const selfRestartSchema = z.object({
  expectedWorkspacePath: z.string().min(1),
  expectedPackageName: z.string().min(1),
  expectedProcessId: z.number().int().min(1),
  confirmSelfRestart: z.boolean().default(false),
}).strict();
const npmRestartChainSchema = z.object({ workspacePath: z.string().min(1), confirmRestart: z.boolean().default(false) }).strict();

export function registerQaTools(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  const registration = buildConsoleToolRegistration(authConfig);
  const mutationRegistration = buildConsoleMutationToolRegistration(authConfig);
  registerJsonProbeTool(server, policy, registration);

  server.registerTool(
    "console.write.package.composer.script.run",
    {
      description: "Run an allowed Composer script in a workspace.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        script: z.string().min(1).max(120),
      }).strict(),
      ...mutationRegistration,
    },
    async ({ workspacePath, script }) => textResult(await runComposer(policy, workspacePath, script))
  );

  server.registerTool(
    "console.read_.repo.memory.scope.resolve",
    {
      description: "Resolve the Code Memory active/read/edit scope for a workspace using its declared memory:scope:resolve Composer script.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
      }).strict(),
      ...registration,
    },
    async ({ workspacePath }) => textResult(await runCodeMemoryScopeResolve(policy, workspacePath))
  );

  server.registerTool(
    "console.read_.repo.memory.graph.plan",
    {
      description: "Plan explicit Code Memory graph targets for search_graph/query_graph/trace_path without running a raw unscoped graph search.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        operation: z.enum(["search_graph", "query_graph", "trace_path", "get_code_snippet", "get_architecture", "search_code"]).default("search_graph"),
        implementationFlow: z.boolean().default(true),
      }).strict(),
      ...registration,
    },
    async ({ workspacePath, operation, implementationFlow }) => textResult(await runCodeMemoryGraphPlan(policy, workspacePath, operation, implementationFlow))
  );

  for (const alias of [
    { name: "console.read_.package.composer.validate", command: "validate", description: "Run composer validate in a workspace." },
    { name: "console.read_.package.composer.show", command: "show", description: "Run composer show in a workspace." },
    { name: "console.read_.package.composer.audit", command: "audit", description: "Run composer audit in a workspace." },
    { name: "console.read_.package.composer.outdated", command: "outdated", description: "Run composer outdated in a workspace." },
  ] as const) {
    server.registerTool(
      alias.name,
      {
        description: alias.description,
        inputSchema: z.object({
          workspacePath: z.string().min(1),
          packages: z.array(z.string().min(1)).max(20).optional(),
          flags: z.object({
            noInteraction: z.boolean().optional(),
            noProgress: z.boolean().optional(),
            noScripts: z.boolean().optional(),
            noPlugins: z.boolean().optional(),
            noDev: z.boolean().optional(),
            dryRun: z.boolean().optional(),
            preferDist: z.boolean().optional(),
            preferSource: z.boolean().optional(),
            preferStable: z.boolean().optional(),
            withAllDependencies: z.boolean().optional(),
            noInstall: z.boolean().optional(),
            optimizeAutoloader: z.boolean().optional(),
            classmapAuthoritative: z.boolean().optional(),
            apcuAutoloader: z.boolean().optional(),
            strict: z.boolean().optional(),
            checkLock: z.boolean().optional(),
            noCheckAll: z.boolean().optional(),
            locked: z.boolean().optional(),
            direct: z.boolean().optional(),
            minorOnly: z.boolean().optional(),
            majorOnly: z.boolean().optional(),
            patchOnly: z.boolean().optional(),
            format: z.enum(["text", "json", "summary"]).optional(),
          }).strict().optional(),
          timeoutMs: z.number().int().min(10000).max(300000).optional(),
        }).strict(),
        ...registration,
      },
      async (input) => textResult(await runComposerCommand(policy, { ...input, command: alias.command }))
    );
  }

  server.registerTool(
    "console.write.package.composer.install",
    {
      description: "Run composer install in a workspace.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        packages: z.array(z.string().min(1)).max(20).optional(),
        flags: z.object({
          noInteraction: z.boolean().optional(),
          noProgress: z.boolean().optional(),
          noScripts: z.boolean().optional(),
          noPlugins: z.boolean().optional(),
          noDev: z.boolean().optional(),
          dryRun: z.boolean().optional(),
          preferDist: z.boolean().optional(),
          preferSource: z.boolean().optional(),
          preferStable: z.boolean().optional(),
          withAllDependencies: z.boolean().optional(),
          noInstall: z.boolean().optional(),
          optimizeAutoloader: z.boolean().optional(),
          classmapAuthoritative: z.boolean().optional(),
          apcuAutoloader: z.boolean().optional(),
          strict: z.boolean().optional(),
          checkLock: z.boolean().optional(),
          noCheckAll: z.boolean().optional(),
          locked: z.boolean().optional(),
          direct: z.boolean().optional(),
          minorOnly: z.boolean().optional(),
          majorOnly: z.boolean().optional(),
          patchOnly: z.boolean().optional(),
          format: z.enum(["text", "json", "summary"]).optional(),
        }).strict().optional(),
        timeoutMs: z.number().int().min(10000).max(300000).optional(),
      }).strict(),
      ...mutationRegistration,
    },
    async (input) => textResult(await runComposerCommand(policy, { ...input, command: "install" }))
  );

  server.registerTool(
    "console.write.package.composer.update",
    {
      description: "Run composer update in a workspace. Package-scoped updates are allowed by default; full update requires allowAllPackages=true.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        packages: z.array(z.string().min(1)).max(20).optional(),
        allowAllPackages: z.boolean().optional(),
        flags: z.object({
          noInteraction: z.boolean().optional(),
          noProgress: z.boolean().optional(),
          noScripts: z.boolean().optional(),
          noPlugins: z.boolean().optional(),
          noDev: z.boolean().optional(),
          dryRun: z.boolean().optional(),
          preferDist: z.boolean().optional(),
          preferSource: z.boolean().optional(),
          preferStable: z.boolean().optional(),
          withAllDependencies: z.boolean().optional(),
          noInstall: z.boolean().optional(),
          optimizeAutoloader: z.boolean().optional(),
          classmapAuthoritative: z.boolean().optional(),
          apcuAutoloader: z.boolean().optional(),
        }).strict().optional(),
        timeoutMs: z.number().int().min(10000).max(300000).optional(),
      }).strict(),
      ...mutationRegistration,
    },
    async (input) => textResult(await runComposerCommand(policy, { ...input, command: "update" }))
  );

  for (const alias of [
    { name: "console.read_.package.npm.typecheck", script: "typecheck", description: "Run npm typecheck in a workspace." },
    { name: "console.read_.package.npm.test", script: "test", description: "Run npm test in a workspace." },
    { name: "console.read_.package.npm.smoke", script: "smoke", description: "Run npm smoke in a workspace." },
  ] as const) {
    server.registerTool(
      alias.name,
      {
        description: alias.description,
        inputSchema: z.object({ workspacePath: z.string().min(1) }).strict(),
        ...registration,
      },
      async ({ workspacePath }) => textResult(await runAllowedScript(policy, workspacePath, "npm", ["run", alias.script], 120000))
    );
  }

  server.registerTool(
    "console.read_.system.console.restart.plan",
    {
      description: "Plan a console restart route without executing it.",
      inputSchema: restartPlanSchema,
      ...registration,
    },
    async ({ workspacePath }) => textResult(buildRestartPlan(policy, workspacePath))
  );

  server.registerTool(
    "console.write.package.npm.dev.restart",
    {
      description: "Run npm run dev:restart for a non-self workspace after confirmation.",
      inputSchema: npmDevRestartSchema,
      ...mutationRegistration,
    },
    async ({ workspacePath, confirmRestart }) => textResult(await runNpmDevRestart(policy, workspacePath, confirmRestart))
  );

  server.registerTool(
    "console.write.system.console.self.restart",
    {
      description: "Restart this console MCP runtime after exact identity and process confirmation.",
      inputSchema: selfRestartSchema,
      ...mutationRegistration,
    },
    async (input) => textResult(await runConsoleSelfRestart(policy, input))
  );

  server.registerTool(
    "console.write.package.npm.restart",
    {
      description: "Compatibility restart chain: plan first, then route to npm dev restart or guarded self restart.",
      inputSchema: npmRestartChainSchema,
      ...mutationRegistration,
    },
    async ({ workspacePath, confirmRestart }) => textResult(await runNpmRestart(policy, workspacePath, confirmRestart))
  );

  server.registerTool(
    "console.read_.package.php.lint.file",
    {
      description: "Run php -l for one repository PHP file.",
      inputSchema: z.object({ workspacePath: z.string().min(1), filePath: z.string().min(1) }).strict(),
      ...registration,
    },
    async ({ workspacePath, filePath }) => textResult(await checkPhpFile(policy, workspacePath, filePath))
  );

  server.registerTool(
    "console.read_.package.php.lint.changed",
    {
      description: "Run php -l for changed repository PHP files.",
      inputSchema: z.object({ workspacePath: z.string().min(1), includeUntracked: z.boolean().optional() }).strict(),
      ...registration,
    },
    async ({ workspacePath, includeUntracked }) => textResult(await lintChangedPhp(policy, workspacePath, Boolean(includeUntracked)))
  );
}

type JsonProbeExpectation = { path: string; equals?: unknown; exists?: boolean };
type JsonProbeInput = { url: string; method?: "GET" | "HEAD"; timeoutMs?: number; maxBodyBytes?: number; jsonPaths?: string[]; expectJson?: JsonProbeExpectation[] };
type ComposerCommand = typeof allowedComposerCommandValues[number];
type ComposerFlagName = keyof ComposerFlags;
type ComposerFlags = {
  noInteraction?: boolean;
  noProgress?: boolean;
  noScripts?: boolean;
  noPlugins?: boolean;
  noDev?: boolean;
  dryRun?: boolean;
  preferDist?: boolean;
  preferSource?: boolean;
  preferStable?: boolean;
  withAllDependencies?: boolean;
  noInstall?: boolean;
  optimizeAutoloader?: boolean;
  classmapAuthoritative?: boolean;
  apcuAutoloader?: boolean;
  strict?: boolean;
  checkLock?: boolean;
  noCheckAll?: boolean;
  locked?: boolean;
  direct?: boolean;
  minorOnly?: boolean;
  majorOnly?: boolean;
  patchOnly?: boolean;
  format?: "text" | "json" | "summary";
};
type ComposerCommandInput = { workspacePath: string; command: ComposerCommand; packages?: string[]; allowAllPackages?: boolean; flags?: ComposerFlags; timeoutMs?: number };

function registerJsonProbeTool(server: McpServer, policy: ConsolePolicy, registration: ReturnType<typeof buildConsoleToolRegistration>): void {
  server.registerTool(
    "console.read_.http.loopback.request",
    {
      description: "Run a safe read-only HTTP request against loopback hosts.",
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
  assertSafeComposerScriptName(script);

  if (!isAllowedComposerScript(script)) {
    throw new Error(`Composer script is not allowed: ${script}`);
  }

  const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);
  if (script !== "validate" && !readWorkspaceComposerScripts(cwd).has(script)) {
    throw new Error(`Composer script is not declared in workspace composer.json: ${script}`);
  }

  const args = script === "validate" ? ["validate"] : ["run-script", script];
  return runAllowedScript(policy, workspacePath, "composer", args, 120000);
}

async function runCodeMemoryGraphPlan(policy: ConsolePolicy, workspacePath: string, operation: string, implementationFlow: boolean): Promise<Record<string, unknown>> {
  const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);
  const scopeEvidence = isWorkspaceUmbrellaRoot(policy, cwd)
    ? buildWorkspaceUmbrellaWarning(policy, cwd)
    : await resolveCompactCodeMemoryScope(cwd);

  return buildCodeMemoryGraphSearchPlan(policy, cwd, scopeEvidence, operation, implementationFlow);
}

async function runCodeMemoryScopeResolve(policy: ConsolePolicy, workspacePath: string): Promise<Record<string, unknown>> {
  const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);
  if (isWorkspaceUmbrellaRoot(policy, cwd)) {
    return buildWorkspaceUmbrellaWarning(policy, cwd);
  }

  const scope = await resolveCompactCodeMemoryScope(cwd);
  return {
    ...scope,
    outputMode: "compact-summary",
    fullScopeOmitted: true,
    fullScopeReason: "The raw host scope can be very large; use the summary/readProjectNames/editProjectNames fields as the stable MCP response contract.",
  };
}

function assertSafeComposerScriptName(script: string): void {
  if (!safeComposerScriptPattern.test(script)) {
    throw new Error(`Composer script contains unsafe characters: ${script}`);
  }
}

function isAllowedComposerScript(script: string): boolean {
  const normalized = script.trim();
  const lower = normalized.toLowerCase();
  if (!safeComposerScriptPattern.test(normalized)) return false;
  if (explicitlyAllowedComposerScripts.has(normalized)) return true;
  if (deniedComposerScriptFragments.some((fragment) => lower === fragment || lower.includes(`${fragment}:`) || lower.includes(`:${fragment}`))) return false;
  return safeComposerScriptPrefixes.some((prefix) => lower === prefix || lower.startsWith(`${prefix}:`) || lower.startsWith(`${prefix}-`));
}

function readWorkspaceComposerScripts(workspace: string): Set<string> {
  const composerPath = path.join(workspace, "composer.json");
  let decoded: unknown;
  try {
    decoded = JSON.parse(readFileSync(composerPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read workspace composer.json: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    return new Set();
  }

  const scripts = (decoded as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
    return new Set();
  }

  return new Set(Object.keys(scripts));
}

async function runComposerCommand(policy: ConsolePolicy, input: ComposerCommandInput): Promise<Record<string, unknown>> {
  const flags = input.flags ?? {};
  const packages = normalizeComposerPackages(input.packages ?? []);
  const args = buildComposerArgs(input.command, packages, Boolean(input.allowAllPackages), flags);
  const timeoutMs = input.timeoutMs ?? defaultComposerTimeoutMs(input.command, flags);
  return runAllowedScript(policy, input.workspacePath, "composer", args, timeoutMs);
}

function normalizeComposerPackages(packages: string[]): string[] {
  const normalized = packages.map((value) => value.trim()).filter(Boolean);
  for (const item of normalized) {
    if (!composerPackagePattern.test(item)) {
      throw new Error(`Composer package name is not allowed: ${item}`);
    }
  }

  return normalized;
}

function buildComposerArgs(command: ComposerCommand, packages: string[], allowAllPackages: boolean, flags: ComposerFlags): string[] {
  assertComposerFlags(command, flags);
  assertComposerPackageScope(command, packages, allowAllPackages);

  const args = [command, ...composerPackagesForCommand(command, packages)];
  appendCommonComposerFlags(args, flags);

  switch (command) {
    case "validate":
      appendBooleanFlag(args, flags.strict, "--strict");
      appendBooleanFlag(args, flags.checkLock, "--check-lock");
      appendBooleanFlag(args, flags.noCheckAll, "--no-check-all");
      break;
    case "install":
      appendInstallUpdateFlags(args, flags);
      break;
    case "update":
      appendInstallUpdateFlags(args, flags);
      appendBooleanFlag(args, flags.withAllDependencies, "--with-all-dependencies");
      appendBooleanFlag(args, flags.noInstall, "--no-install");
      break;
    case "dump-autoload":
      appendBooleanFlag(args, flags.optimizeAutoloader, "--optimize");
      appendBooleanFlag(args, flags.classmapAuthoritative, "--classmap-authoritative");
      appendBooleanFlag(args, flags.apcuAutoloader, "--apcu");
      appendBooleanFlag(args, flags.noDev, "--no-dev");
      appendBooleanFlag(args, flags.noScripts, "--no-scripts");
      break;
    case "show":
      appendBooleanFlag(args, flags.locked, "--locked");
      appendBooleanFlag(args, flags.direct, "--direct");
      appendFormatFlag(args, flags.format, ["text", "json"]);
      break;
    case "audit":
      appendBooleanFlag(args, flags.noDev, "--no-dev");
      appendFormatFlag(args, flags.format, ["text", "json", "summary"]);
      break;
    case "outdated":
      appendBooleanFlag(args, flags.locked, "--locked");
      appendBooleanFlag(args, flags.direct, "--direct");
      appendBooleanFlag(args, flags.strict, "--strict");
      appendBooleanFlag(args, flags.minorOnly, "--minor-only");
      appendBooleanFlag(args, flags.majorOnly, "--major-only");
      appendBooleanFlag(args, flags.patchOnly, "--patch-only");
      appendFormatFlag(args, flags.format, ["text", "json"]);
      break;
  }

  return args;
}

function assertComposerFlags(command: ComposerCommand, flags: ComposerFlags): void {
  const allowedByCommand: Record<ComposerCommand, ComposerFlagName[]> = {
    validate: ["noInteraction", "strict", "checkLock", "noCheckAll"],
    install: ["noInteraction", "noProgress", "noScripts", "noPlugins", "noDev", "dryRun", "preferDist", "preferSource", "preferStable", "optimizeAutoloader", "classmapAuthoritative", "apcuAutoloader"],
    update: ["noInteraction", "noProgress", "noScripts", "noPlugins", "noDev", "dryRun", "preferDist", "preferSource", "preferStable", "withAllDependencies", "noInstall", "optimizeAutoloader", "classmapAuthoritative", "apcuAutoloader"],
    show: ["noInteraction", "locked", "direct", "format"],
    audit: ["noInteraction", "noDev", "format"],
    outdated: ["noInteraction", "locked", "direct", "strict", "minorOnly", "majorOnly", "patchOnly", "format"],
    "dump-autoload": ["noInteraction", "noScripts", "noDev", "optimizeAutoloader", "classmapAuthoritative", "apcuAutoloader"],
  };
  const allowed = new Set<string>(allowedByCommand[command]);
  for (const name of Object.keys(flags)) {
    if (!allowed.has(name)) {
      throw new Error(`Composer flag '${name}' is not allowed for command '${command}'.`);
    }
  }
  if ([flags.minorOnly, flags.majorOnly, flags.patchOnly].filter(Boolean).length > 1) {
    throw new Error("Only one of minorOnly, majorOnly, or patchOnly can be used.");
  }
  if (flags.preferDist && flags.preferSource) {
    throw new Error("Only one of preferDist or preferSource can be used.");
  }
}

function assertComposerPackageScope(command: ComposerCommand, packages: string[], allowAllPackages: boolean): void {
  if (!["update", "show", "outdated"].includes(command) && packages.length > 0) {
    throw new Error(`Composer command '${command}' does not accept packages in this tool.`);
  }
  if (command === "update" && packages.length === 0 && !allowAllPackages) {
    throw new Error("Full composer update requires allowAllPackages=true.");
  }
}

function composerPackagesForCommand(command: ComposerCommand, packages: string[]): string[] {
  return ["update", "show", "outdated"].includes(command) ? packages : [];
}

function appendCommonComposerFlags(args: string[], flags: ComposerFlags): void {
  appendBooleanFlag(args, flags.noInteraction ?? true, "--no-interaction");
  appendBooleanFlag(args, flags.noProgress, "--no-progress");
  appendBooleanFlag(args, flags.noPlugins, "--no-plugins");
}

function appendInstallUpdateFlags(args: string[], flags: ComposerFlags): void {
  appendBooleanFlag(args, flags.dryRun, "--dry-run");
  appendBooleanFlag(args, flags.noScripts, "--no-scripts");
  appendBooleanFlag(args, flags.noDev, "--no-dev");
  appendBooleanFlag(args, flags.preferDist, "--prefer-dist");
  appendBooleanFlag(args, flags.preferSource, "--prefer-source");
  appendBooleanFlag(args, flags.preferStable, "--prefer-stable");
  appendBooleanFlag(args, flags.optimizeAutoloader, "--optimize-autoloader");
  appendBooleanFlag(args, flags.classmapAuthoritative, "--classmap-authoritative");
  appendBooleanFlag(args, flags.apcuAutoloader, "--apcu-autoloader");
}

function appendBooleanFlag(args: string[], enabled: boolean | undefined, flag: string): void {
  if (enabled) {
    args.push(flag);
  }
}

function appendFormatFlag(args: string[], format: ComposerFlags["format"], allowed: Array<NonNullable<ComposerFlags["format"]>>): void {
  if (!format || format === "text") {
    return;
  }
  if (!allowed.includes(format)) {
    throw new Error(`Composer output format is not allowed for this command: ${format}`);
  }
  args.push(`--format=${format}`);
}

function defaultComposerTimeoutMs(command: ComposerCommand, flags: ComposerFlags): number {
  if (command === "install" || command === "update") {
    return flags.dryRun ? 120000 : 300000;
  }
  return 120000;
}

function buildRestartPlan(policy: ConsolePolicy, workspacePath: string): Record<string, unknown> {
  const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);
  const currentCwd = process.cwd();
  const isSelfRestart = isSameFilesystemPath(cwd, currentCwd);
  const packageName = readPackageName(cwd);
  return {
    ok: true,
    status: "CONSOLE_RESTART_PLAN_READY",
    requested_workspace_path: cwd,
    current_process_cwd: currentCwd,
    current_process_id: process.pid,
    package_name: packageName,
    is_self_restart: isSelfRestart,
    script: "dev:restart",
    command_preview: isSelfRestart ? "pwsh -File tool/dev-console.ps1 start-chatgpt-oauth" : "npm run dev:restart",
    route: isSelfRestart ? "guarded_self_restart" : "npm_dev_restart",
    execute_tool: isSelfRestart ? "console.write.system.console.self.restart" : "console.write.package.npm.dev.restart",
    execute_requires: isSelfRestart
      ? { expectedWorkspacePath: cwd, expectedPackageName: packageName, expectedProcessId: process.pid, confirmSelfRestart: true }
      : { workspacePath: cwd, confirmRestart: true },
    chain_tool: "console.write.package.npm.restart",
    chain_requires: { workspacePath: cwd, confirmRestart: true },
    policy: buildRestartPlanPolicy(),
  };
}

async function runNpmDevRestart(policy: ConsolePolicy, workspacePath: string, confirmRestart: boolean): Promise<Record<string, unknown>> {
  const plan = buildRestartPlan(policy, workspacePath);
  if (plan.is_self_restart === true) {
    return { ok: false, status: "NPM_DEV_RESTART_SELF_ROUTE_BLOCKED", plan, policy: buildNpmDevRestartPolicy() };
  }
  if (!confirmRestart) {
    return { ok: false, status: "CONFIRM_NPM_DEV_RESTART_REQUIRED", plan, policy: buildNpmDevRestartPolicy() };
  }
  return runAllowedScript(policy, workspacePath, "npm", ["run", "dev:restart"], 120000);
}

async function runConsoleSelfRestart(policy: ConsolePolicy, input: z.infer<typeof selfRestartSchema>): Promise<Record<string, unknown>> {
  const plan = buildRestartPlan(policy, input.expectedWorkspacePath);
  if (plan.is_self_restart !== true) return { ok: false, status: "SELF_RESTART_WORKSPACE_MISMATCH", plan, policy: buildSelfRestartPolicy() };
  if (plan.package_name !== input.expectedPackageName) return { ok: false, status: "SELF_RESTART_PACKAGE_MISMATCH", expected_package_name: input.expectedPackageName, actual_package_name: plan.package_name, plan, policy: buildSelfRestartPolicy() };
  if (process.pid !== input.expectedProcessId) return { ok: false, status: "SELF_RESTART_PROCESS_MISMATCH", expected_process_id: input.expectedProcessId, actual_process_id: process.pid, plan, policy: buildSelfRestartPolicy() };
  if (!input.confirmSelfRestart) return { ok: false, status: "CONFIRM_SELF_RESTART_REQUIRED", plan, policy: buildSelfRestartPolicy() };

  const cwd = String(plan.requested_workspace_path);
  const devConsole = path.join(cwd, "tool", "dev-console.ps1");
  const child = spawn("pwsh", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", devConsole, "start-chatgpt-oauth"], { cwd, detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return { ok: true, status: "SELF_RESTART_ACCEPTED", mode: "detached_unified_lifecycle_restart", command: "pwsh -File tool/dev-console.ps1 start-chatgpt-oauth", cwd, supervisorPid: process.pid, detachedPid: child.pid ?? null, policy: buildSelfRestartPolicy() };
}

async function runNpmRestart(policy: ConsolePolicy, workspacePath: string, confirmRestart: boolean): Promise<Record<string, unknown>> {
  const plan = buildRestartPlan(policy, workspacePath);
  if (!confirmRestart) return { ok: false, status: "CONFIRM_RESTART_CHAIN_REQUIRED", plan, policy: buildRestartChainPolicy() };
  if (plan.is_self_restart === true) {
    return runConsoleSelfRestart(policy, {
      expectedWorkspacePath: String(plan.requested_workspace_path),
      expectedPackageName: String(plan.package_name),
      expectedProcessId: Number(plan.current_process_id),
      confirmSelfRestart: true,
    });
  }
  return runNpmDevRestart(policy, workspacePath, true);
}

function readPackageName(workspacePath: string): string | null {
  try {
    const decoded = JSON.parse(readFileSync(path.join(workspacePath, "package.json"), "utf8")) as { name?: unknown };
    return typeof decoded.name === "string" && decoded.name.length > 0 ? decoded.name : null;
  } catch {
    return null;
  }
}

function buildRestartPlanPolicy(): Record<string, unknown> {
  return { mutation: false, restart_execution: false, returns_execute_tool: true };
}

function buildNpmDevRestartPolicy(): Record<string, unknown> {
  return { mutation: true, restart_execution: true, self_restart: false, command: "npm run dev:restart", requires_confirm_restart: true };
}

function buildSelfRestartPolicy(): Record<string, unknown> {
  return { mutation: true, restart_execution: true, self_restart: true, command: "pwsh -File tool/dev-console.ps1 start-chatgpt-oauth", unified_runtime: true, secret_bootstrap: true, requires_expected_workspace: true, requires_expected_package: true, requires_expected_process_id: true, requires_confirm_self_restart: true };
}

function buildRestartChainPolicy(): Record<string, unknown> {
  return { mutation: true, restart_chain: true, plan_first: true, routes_to_specific_execute_tool: true, requires_confirm_restart: true };
}

async function runAllowedScript(policy: ConsolePolicy, workspacePath: string, commandName: string, args: string[], timeoutMs: number): Promise<Record<string, unknown>> {
  const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);
  const result = await runSupervisedCommand(cwd, commandName, args, timeoutMs, 4 * 1024 * 1024);
  const stdout = truncateOutput(result.stdout);
  const stderr = truncateOutput(result.stderr);
  return { ok: result.ok, command: [commandName, ...args].join(" "), cwd, exitCode: result.exitCode, stdout: stdout.text, stdoutTruncated: stdout.truncated, stderr: stderr.text, stderrTruncated: stderr.truncated };
}

function isSameFilesystemPath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

async function checkPhpFile(policy: ConsolePolicy, workspacePath: string, filePath: string): Promise<Record<string, unknown>> {
  return runAllowedScript(policy, workspacePath, "php", ["-l", normalizeRepoPath(filePath)], 30000);
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

