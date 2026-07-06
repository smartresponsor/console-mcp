import { readFile } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { assertAllowedRoot } from "../Policy/PathGuard.js";
import { buildConsoleToolRegistration, textResult, truncateText } from "./common.js";

type Method = "GET" | "HEAD";
type JsonExpectation = { path: string; equals?: unknown; exists?: boolean };
type Input = {
  workspacePath?: string;
  url: string;
  method?: Method;
  cookieFile?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
  jsonPaths?: string[];
  expectJson?: JsonExpectation[];
};

const SENSITIVE_HEADER = new Set(["authorization", "cookie", "proxy-authorization", "set-cookie", "x-api-key", "x-auth-token", "x-csrf-token", "x-xsrf-token"]);
const SENSITIVE_QUERY = /(token|secret|password|passwd|pwd|key|auth|session|csrf|xsrf|signature|sig|code|state)/i;
const TEXTUAL_CT = /^(text\/)|(?:json|xml|html|javascript|ecmascript|x-www-form-urlencoded)/i;

const inputSchema = z.object({
  workspacePath: z.string().min(1).optional(),
  url: z.string().min(1),
  method: z.enum(["GET", "HEAD"]).optional(),
  cookieFile: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1000).max(30000).optional(),
  maxBodyBytes: z.number().int().min(0).max(4 * 1024 * 1024).optional(),
  jsonPaths: z.array(z.string().min(1)).max(100).optional(),
  expectJson: z.array(z.object({
    path: z.string().min(1),
    equals: z.unknown().optional(),
    exists: z.boolean().optional(),
  }).strict()).max(100).optional(),
}).strict();

export function registerLocalCurlTool(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  server.registerTool("console.read_.http.loopback.curl", {
    description: "Run a safe read-only curl-like request against localhost/loopback URLs.",
    inputSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(await localCurl(policy, input)));
}

async function localCurl(policy: ConsolePolicy, input: Input): Promise<Record<string, unknown>> {
  const method = input.method ?? "GET";
  const timeoutMs = input.timeoutMs ?? 10000;
  const maxBodyBytes = input.maxBodyBytes ?? 1024 * 1024;
  const url = parseLocalUrl(input.url);
  const workspacePath = input.workspacePath ? assertAllowedRoot(input.workspacePath, policy.allowedRoots) : null;
  const cookie = input.cookieFile ? await readCookie(policy, input.cookieFile, workspacePath) : null;
  const startedAt = Date.now();
  const response = await requestOnce(url, method, timeoutMs, maxBodyBytes, cookie);
  const json = parseJson(response.body, response.contentType);
  const paths = json.ok ? extractJsonPaths(json.value, input.jsonPaths ?? []) : {};
  const expectations = json.ok ? checkExpectations(json.value, input.expectJson ?? []) : [];

  return {
    ok: response.error === null && successStatus(response.statusCode) && expectations.every((item) => item.ok),
    mode: "safe-local-curl-readonly",
    policy: {
      allowedSchemes: ["http", "https"],
      allowedHosts: ["localhost", "*.localhost", "127.0.0.0/8", "::1"],
      methods: ["GET", "HEAD"],
      externalNetwork: "denied",
      cookieOutput: "redacted",
    },
    request: {
      method,
      url: sanitizeUrl(url),
      workspacePath,
      cookieFile: input.cookieFile ?? null,
      cookieLoaded: cookie !== null,
      timeoutMs,
      maxBodyBytes,
      jsonPaths: input.jsonPaths ?? [],
      expectJson: input.expectJson ?? [],
    },
    response: {
      ...response,
      durationMs: Date.now() - startedAt,
    },
    json: json.ok ? { ok: true, paths, expectations } : { ok: false, error: json.error, paths: {}, expectations: [] },
  };
}

async function readCookie(policy: ConsolePolicy, cookieFile: string, workspacePath: string | null): Promise<string> {
  const filePath = workspacePath && !isAbsolutePath(cookieFile) ? `${workspacePath.replace(/[\\/]+$/, "")}/${cookieFile}` : cookieFile;
  const safePath = assertAllowedRoot(filePath, policy.allowedRoots);
  return (await readFile(safePath, "utf8")).trim();
}

function requestOnce(url: URL, method: Method, timeoutMs: number, maxBodyBytes: number, cookie: string | null): Promise<Record<string, unknown> & { statusCode: number | null; contentType: string | null; body: string; error: string | null }> {
  assertLocalUrl(url);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bodyBytesRead = 0;
    let bodyTruncated = false;
    let settled = false;
    const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
    const agent = url.protocol === "https:" ? new HttpsAgent({ rejectUnauthorized: false }) : undefined;
    const headers: Record<string, string> = {
      Accept: "application/json,text/plain,*/*;q=0.5",
      "User-Agent": "console-mcp-local-curl/1.0 readonly-diagnostic",
    };
    if (cookie) {
      headers.Cookie = cookie;
    }

    const req = requestFn(url, { method, timeout: timeoutMs, agent, headers }, (res) => {
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
        const responseHeaders = sanitizeHeaders(res.headers);
        const contentType = responseHeaders["content-type"] ?? null;
        const rawBody = Buffer.concat(chunks);
        const body = contentType === null || TEXTUAL_CT.test(contentType) ? truncateText(rawBody.toString("utf8"), maxBodyBytes).text : `[${rawBody.length} binary bytes omitted]`;
        resolve({
          statusCode: res.statusCode ?? null,
          statusMessage: res.statusMessage ?? null,
          headers: responseHeaders,
          contentType,
          body,
          bodyBytesRead,
          bodyTruncated,
          error: null,
        });
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

function parseJson(body: string, contentType: string | null): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = body.trim();
  if (!trimmed) return { ok: false, error: "empty_body" };
  if (contentType !== null && !/(json|problem\+json)/i.test(contentType) && !trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return { ok: false, error: `non_json_content_type:${contentType}` };
  }
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

function checkExpectations(json: unknown, expectations: JsonExpectation[]): Array<Record<string, unknown>> {
  return expectations.map((expectation) => {
    const result = resolveJsonPath(json, expectation.path);
    const expectedExists = expectation.exists ?? true;
    if (result.exists !== expectedExists) return { path: expectation.path, ok: false, actualExists: result.exists };
    if ("equals" in expectation && JSON.stringify(result.value) !== JSON.stringify(expectation.equals)) return { path: expectation.path, ok: false, actual: result.value, expected: expectation.equals };
    return { path: expectation.path, ok: true, actual: result.exists ? result.value : null };
  });
}

function resolveJsonPath(value: unknown, path: string): { exists: boolean; value: unknown } {
  const normalized = path.startsWith("$.") ? path.slice(2) : path.replace(/^\$\.?/, "");
  if (!normalized) return { exists: true, value };
  let current: unknown = value;
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

function parseLocalUrl(raw: string): URL { const url = new URL(raw); url.hash = ""; assertLocalUrl(url); return url; }
function assertLocalUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Only http and https localhost URLs are allowed: ${sanitizeUrl(url)}`);
  if (url.username || url.password) throw new Error("Credentials in localhost URLs are not allowed.");
  if (!isLocalUrl(url)) throw new Error(`Only loopback localhost hosts are allowed: ${sanitizeUrl(url)}`);
}
function isLocalUrl(url: URL): boolean {
  const host = url.hostname.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0:0:0:0:0:0:0:1" || loopbackIpv4(host);
}

function loopbackIpv4(host: string): boolean {
  const parts = host.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number.parseInt(part, 10) >= 0 && Number.parseInt(part, 10) <= 255);
}

function successStatus(status: number | null): boolean { return status !== null && status >= 200 && status < 400; }
function isAbsolutePath(filePath: string): boolean { return /^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith("/") || filePath.startsWith("\\\\"); }

function sanitizeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (SENSITIVE_HEADER.has(lower)) out[lower] = "[redacted]";
    else if (Array.isArray(value)) out[lower] = value.join(", ");
    else if (value !== undefined) out[lower] = String(value);
  }
  return out;
}

function sanitizeUrl(url: URL): string {
  const clone = new URL(url.href);
  clone.username = "";
  clone.password = "";
  for (const key of Array.from(clone.searchParams.keys())) if (SENSITIVE_QUERY.test(key)) clone.searchParams.set(key, "[redacted]");
  return clone.href;
}

