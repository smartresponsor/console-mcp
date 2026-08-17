import { mkdir, appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { decodeJwt, decodeProtectedHeader, type JWTPayload } from "jose";
import type { ConsoleAuthConfig } from "../../Security/Auth/ConsoleAuth.js";

export type HttpTraceRecord = {
  timestamp: string;
  method: string;
  path: string;
  user_agent: string | null;
  has_authorization_header: boolean;
  authorization_scheme: string | null;
  status_code: number;
  duration_ms: number;
  auth_mode: ConsoleAuthConfig["mode"];
};

export type OAuthDebugRecord = {
  timestamp: string;
  alg: string | null;
  kid: string | null;
  iss: string | null;
  aud: string | string[] | null;
  azp: string | null;
  scope: string | string[] | null;
  permissions: string[] | null;
  exp: number | null;
  nbf: number | null;
  result: "success" | "failure";
  failure_stage: string;
  error_message: string | null;
};

export type OAuthDebugTokenSnapshot = {
  header: {
    alg: string | undefined;
    kid: string | undefined;
  };
  claims: JWTPayload;
} | null;

export type CmcpGoTraceRecord = {
  timestamp: string;
  ok: boolean;
  status: string;
  workspace_path: string | null;
  component_name: string | null;
  plan_status: string | null;
  enriched_prompt_hash: string | null;
  enriched_prompt_length: number | null;
  preflight_status: string | null;
  opened_status: string | null;
  opened_target_id: string | null;
  opened_url: string | null;
  opened_chat_id: string | null;
  drafted_status: string | null;
  draft_inner_status: string | null;
  draft_hash: string | null;
  draft_length: number | null;
  submitted_status: string | null;
  submitted: boolean;
  submit_inner_status: string | null;
  current_draft_hash: string | null;
  current_draft_length: number | null;
  rate_limit_status: string | null;
  skipped_reusable_target_count: number;
};

export type McpRequestTraceRecord = {
  timestamp: string;
  correlation_id: string;
  pid: number;
  profile: string;
  consumer: string;
  http_method: string;
  path: string;
  user_agent: string | null;
  client: Record<string, unknown>;
  auth_mode: ConsoleAuthConfig["mode"];
  auth_success: boolean | null;
  auth_failure_class: string | null;
  jsonrpc_id: string | number | null;
  jsonrpc_method: string | null;
  http_status: number | null;
  response_completed_at: string | null;
  elapsed_ms: number | null;
  mcp_dispatch_reached: boolean;
  transport_handle_completed: boolean;
  transport_handle_threw: boolean;
  response_finish_fired: boolean;
  response_close_fired: boolean;
  exception_class: string | null;
  exception_message: string | null;
};

export type McpMethodTraceRecord = {
  timestamp: string;
  correlation_id: string;
  pid: number;
  profile: string;
  consumer: string;
  event: "method_start" | "method_end";
  method: "tools/list" | "tools/call";
  jsonrpc_id: string | number | null;
  tool_name: string | null;
  result_classification: string | null;
  http_status: number | null;
  elapsed_ms: number | null;
  exception_class: string | null;
  exception_message: string | null;
};

const traceEnabled = process.env.CONSOLE_MCP_TRACE === "1";
const oauthDebugEnabled = process.env.CONSOLE_MCP_OAUTH_DEBUG === "1";
const cmcpGoTraceEnabled = process.env.CONSOLE_MCP_CMCP_GO_TRACE !== "0";

export function isTraceEnabled(): boolean {
  return traceEnabled;
}

export function isOAuthDebugEnabled(): boolean {
  return oauthDebugEnabled;
}

export function buildHttpTraceRecord(
  req: IncomingMessage,
  pathValue: string,
  authMode: ConsoleAuthConfig["mode"],
  statusCode: number,
  durationMs: number,
): HttpTraceRecord {
  return {
    timestamp: new Date().toISOString(),
    method: req.method ?? "UNKNOWN",
    path: pathValue,
    user_agent: normalizeHeader(req.headers["user-agent"]),
    has_authorization_header: typeof req.headers.authorization === "string" && req.headers.authorization.length > 0,
    authorization_scheme: extractAuthorizationScheme(req.headers.authorization),
    status_code: statusCode,
    duration_ms: durationMs,
    auth_mode: authMode,
  };
}

export async function recordHttpTrace(
  transcriptDir: string,
  record: HttpTraceRecord,
): Promise<void> {
  if (!traceEnabled) {
    return;
  }

  await appendJsonLine(path.join(transcriptDir, "http-trace.ndjson"), record);
}

export function decodeOAuthTokenSnapshot(token: string): OAuthDebugTokenSnapshot {
  try {
    const header = decodeProtectedHeader(token);
    const claims = decodeJwt(token);
    return {
      header: {
        alg: typeof header.alg === "string" ? header.alg : undefined,
        kid: typeof header.kid === "string" ? header.kid : undefined,
      },
      claims,
    };
  } catch {
    return null;
  }
}

export function buildOAuthDebugRecord(
  snapshot: OAuthDebugTokenSnapshot,
  result: "success" | "failure",
  failureStage: string,
  errorMessage: string | null,
): OAuthDebugRecord {
  const claims = snapshot?.claims;
  return {
    timestamp: new Date().toISOString(),
    alg: snapshot?.header.alg ?? null,
    kid: snapshot?.header.kid ?? null,
    iss: typeof claims?.iss === "string" ? claims.iss : null,
    aud: typeof claims?.aud === "string" || Array.isArray(claims?.aud) ? (claims?.aud as string | string[] | null) : null,
    azp: typeof claims?.azp === "string" ? claims.azp : null,
    scope: typeof claims?.scope === "string" || Array.isArray(claims?.scope) ? (claims?.scope as string | string[] | null) : null,
    permissions: Array.isArray(claims?.permissions)
      ? claims.permissions.filter((item): item is string => typeof item === "string")
      : null,
    exp: typeof claims?.exp === "number" ? claims.exp : null,
    nbf: typeof claims?.nbf === "number" ? claims.nbf : null,
    result,
    failure_stage: failureStage,
    error_message: errorMessage,
  };
}

export async function recordOAuthDebug(
  transcriptDir: string,
  record: OAuthDebugRecord,
): Promise<void> {
  if (!oauthDebugEnabled) {
    return;
  }

  await appendJsonLine(path.join(transcriptDir, "oauth-debug.ndjson"), record);
}

export async function recordCmcpGoTrace(
  transcriptDir: string,
  record: CmcpGoTraceRecord,
): Promise<void> {
  if (!cmcpGoTraceEnabled) {
    return;
  }

  await appendJsonLine(path.join(transcriptDir, "cmcp-go-trace.ndjson"), record);
}

export async function recordMcpRequestTrace(
  transcriptDir: string,
  record: McpRequestTraceRecord,
): Promise<void> {
  await appendJsonLine(path.join(transcriptDir, "mcp-request-trace.ndjson"), record);
}

export async function recordMcpMethodTrace(
  transcriptDir: string,
  record: McpMethodTraceRecord,
): Promise<void> {
  await appendJsonLine(path.join(transcriptDir, "mcp-method-trace.ndjson"), record);
}

export function sanitizeDiagnosticError(error: unknown): { className: string; message: string } {
  const className = error instanceof Error && error.name ? error.name : typeof error;
  const raw = error instanceof Error ? error.message : String(error);
  return {
    className: sanitizeDiagnosticText(className).slice(0, 120),
    message: sanitizeDiagnosticText(raw).slice(0, 1000),
  };
}

export function sanitizeDiagnosticText(value: string): string {
  return value
    .replace(/Authorization:\s*Bearer\s+[^\s"]+/gi, "Authorization: Bearer [redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/g, "[redacted-jwt]")
    .replace(/\b(client_secret|authorization_code|refresh_token|access_token|token|code)\b\s*[:=]\s*[^,\s"]+/gi, "$1=[redacted]")
    .replace(/([?&](?:token|code|refresh_token|client_secret|access_token)=[^&\s]+)/gi, "[redacted]");
}

function extractAuthorizationScheme(value: string | string[] | undefined): string | null {
  const header = Array.isArray(value) ? value[0] : value;
  if (!header) {
    return null;
  }

  const match = header.match(/^([A-Za-z][A-Za-z0-9_-]*)\s+/);
  return match ? match[1] : null;
}

function normalizeHeader(value: string | string[] | undefined): string | null {
  const header = Array.isArray(value) ? value[0] : value;
  if (!header) {
    return null;
  }

  return header;
}

async function appendJsonLine(filePath: string, record: unknown): Promise<void> {
  const line = `${JSON.stringify(record)}\n`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, line, "utf8");
}

