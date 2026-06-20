import { mkdir, appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { decodeJwt, decodeProtectedHeader, type JWTPayload } from "jose";
import type { ConsoleAuthConfig } from "./auth.js";

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

const traceEnabled = process.env.CONSOLE_MCP_TRACE === "1";
const oauthDebugEnabled = process.env.CONSOLE_MCP_OAUTH_DEBUG === "1";

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
