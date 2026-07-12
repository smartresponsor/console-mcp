import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { buildOAuthDebugRecord, decodeOAuthTokenSnapshot, recordOAuthDebug } from "../../Infrastructure/Diagnostics/RuntimeDiagnostics.js";

export type ConsoleAuthConfig = BearerAuthConfig | OAuthAuthConfig;

export type BearerAuthConfig = {
  mode: "bearer";
  bearerTokens: string[];
};

export type OAuthAuthConfig = {
  mode: "oauth";
  publicOrigin: string;
  issuer: string;
  audience: string;
  readScope: string;
  writeScope: string;
  requiredScope: string;
  jwksUri: string | null;
  resourceMetadataUrl: string;
};

export type AuthDecision =
  | { authorized: true }
  | { authorized: false; statusCode: number; challenge: string; message: string };

type OAuthJwksDiscovery = {
  jwksUri: string;
  remoteJwks: ReturnType<typeof createRemoteJWKSet>;
};

const jwksCache = new Map<string, OAuthJwksDiscovery>();

export function loadConsoleAuthConfig(): ConsoleAuthConfig {
  return loadConsoleAuthConfigForMode(normalizeAuthMode(process.env.CONSOLE_MCP_AUTH_MODE));
}

export function loadConsoleAuthConfigForMode(mode: "bearer" | "oauth"): ConsoleAuthConfig {
  return mode === "oauth" ? loadOAuthAuthConfig() : loadBearerAuthConfig();
}

export function isOAuthProtectedResourceMetadataRequest(url: URL, authConfig: ConsoleAuthConfig): boolean {
  return authConfig.mode === "oauth" && url.pathname === "/.well-known/oauth-protected-resource";
}

export function buildProtectedResourceMetadata(authConfig: ConsoleAuthConfig): Record<string, unknown> | null {
  if (authConfig.mode !== "oauth") {
    return null;
  }

  const scopesSupported = authConfig.readScope === authConfig.writeScope
    ? [authConfig.readScope]
    : [authConfig.readScope, authConfig.writeScope];

  return {
    resource: authConfig.publicOrigin,
    authorization_servers: [authConfig.issuer],
    scopes_supported: scopesSupported,
    bearer_methods_supported: ["header"],
  };
}

export function buildUnauthorizedChallenge(authConfig: ConsoleAuthConfig): string {
  if (authConfig.mode !== "oauth") {
    return "Bearer";
  }

  return `Bearer resource_metadata="${authConfig.resourceMetadataUrl}", scope="${authConfig.requiredScope}"`;
}

export function buildUnauthorizedResponse(authConfig: ConsoleAuthConfig, message = "Unauthorized."): AuthDecision {
  return {
    authorized: false,
    statusCode: 401,
    challenge: buildUnauthorizedChallenge(authConfig),
    message,
  };
}

export async function authorizeRequest(req: IncomingMessage, authConfig: ConsoleAuthConfig, transcriptDir: string): Promise<AuthDecision> {
  const authorization = req.headers.authorization;
  const token = extractBearerToken(authorization);

  if (!token) {
    return buildUnauthorizedResponse(authConfig);
  }

  if (authConfig.mode === "bearer") {
    return authConfig.bearerTokens.some((candidate) => safeCompare(token, candidate))
      ? { authorized: true }
      : buildUnauthorizedResponse(authConfig);
  }

  try {
    await verifyOAuthToken(authConfig, token, transcriptDir);
    return { authorized: true };
  } catch {
    return buildUnauthorizedResponse(authConfig);
  }
}

function loadBearerAuthConfig(): BearerAuthConfig {
  const token = process.env.CONSOLE_MCP_BEARER_TOKEN?.trim();
  if (!token) {
    throw new Error("CONSOLE_MCP_BEARER_TOKEN must be set before starting console-mcp.");
  }

  const previousToken = process.env.CONSOLE_MCP_BEARER_TOKEN_PREVIOUS?.trim();
  const bearerTokens = Array.from(new Set([token, previousToken].filter((value): value is string => Boolean(value))));

  return {
    mode: "bearer",
    bearerTokens,
  };
}

function loadOAuthAuthConfig(): OAuthAuthConfig {
  const publicOrigin = normalizeHttpsOrHttpOrigin(process.env.CONSOLE_MCP_PUBLIC_ORIGIN, "CONSOLE_MCP_PUBLIC_ORIGIN");
  const issuer = normalizeIssuerOrigin(process.env.CONSOLE_MCP_OAUTH_ISSUER, "CONSOLE_MCP_OAUTH_ISSUER");
  const audience = normalizeHttpsOrHttpOrigin(process.env.CONSOLE_MCP_OAUTH_AUDIENCE, "CONSOLE_MCP_OAUTH_AUDIENCE");
  const readScope = process.env.CONSOLE_MCP_OAUTH_READ_SCOPE?.trim()
    || process.env.CONSOLE_MCP_OAUTH_REQUIRED_SCOPE?.trim()
    || "console:read";
  const writeScope = process.env.CONSOLE_MCP_OAUTH_WRITE_SCOPE?.trim() || "console:write";
  const jwksUriValue = process.env.CONSOLE_MCP_OAUTH_JWKS_URI?.trim() || null;
  const jwksUri = jwksUriValue ? normalizeUrl(jwksUriValue, "CONSOLE_MCP_OAUTH_JWKS_URI") : null;

  return {
    mode: "oauth",
    publicOrigin,
    issuer,
    audience,
    readScope,
    writeScope,
    requiredScope: process.env.CONSOLE_MCP_OAUTH_REQUIRED_SCOPE?.trim() || readScope,
    jwksUri,
    resourceMetadataUrl: new URL("/.well-known/oauth-protected-resource", ensureTrailingSlash(publicOrigin)).toString(),
  };
}

function normalizeAuthMode(value: string | undefined): "bearer" | "oauth" {
  const mode = value?.trim().toLowerCase() || "bearer";
  if (mode === "bearer" || mode === "oauth") {
    return mode;
  }

  throw new Error('CONSOLE_MCP_AUTH_MODE must be either "bearer" or "oauth".');
}

function normalizeHttpsOrHttpOrigin(value: string | undefined, envName: string): string {
  const raw = value?.trim();
  if (!raw) {
    throw new Error(`${envName} must be set before starting console-mcp.`);
  }

  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${envName} must use http or https.`);
  }

  if (url.username || url.password) {
    throw new Error(`${envName} must not contain credentials.`);
  }

  return url.origin;
}

function normalizeIssuerOrigin(value: string | undefined, envName: string): string {
  const origin = normalizeHttpsOrHttpOrigin(value, envName);
  return ensureTrailingSlash(origin);
}

function normalizeUrl(value: string, envName: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${envName} must use http or https.`);
  }

  if (url.username || url.password) {
    throw new Error(`${envName} must not contain credentials.`);
  }

  return url.toString();
}

function ensureTrailingSlash(origin: string): string {
  return origin.endsWith("/") ? origin : `${origin}/`;
}

function extractBearerToken(value: string | string[] | undefined): string | null {
  const header = Array.isArray(value) ? value[0] : value;
  if (!header) {
    return null;
  }

  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return null;
  }

  const token = match[1].trim();
  return token ? token : null;
}

function safeCompare(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function verifyOAuthToken(authConfig: OAuthAuthConfig, token: string, transcriptDir: string): Promise<void> {
  const snapshot = decodeOAuthTokenSnapshot(token);
  try {
    const jwks = await getRemoteJwks(authConfig);
    const { payload } = await jwtVerify(token, jwks, {
      issuer: authConfig.issuer,
      audience: authConfig.audience,
      clockTolerance: "5s",
    });

    const scopes = extractScopes(payload as Record<string, unknown>);
    if (!scopes.includes(authConfig.requiredScope)) {
      await recordOAuthDebug(transcriptDir, buildOAuthDebugRecord(snapshot, "failure", "scope_validation", "Missing required scope."));
      throw new Error("Missing required scope.");
    }

    await recordOAuthDebug(transcriptDir, buildOAuthDebugRecord(snapshot, "success", "none", null));
  } catch (error) {
    if (error instanceof Error && error.message === "Missing required scope.") {
      throw error;
    }

    const failureStage = classifyOAuthFailureStage(error);
    const message = sanitizeDiagnosticErrorMessage(error);
    await recordOAuthDebug(transcriptDir, buildOAuthDebugRecord(snapshot, "failure", failureStage, message));
    throw error;
  }
}

async function getRemoteJwks(authConfig: OAuthAuthConfig): Promise<ReturnType<typeof createRemoteJWKSet>> {
  const cacheKey = authConfig.jwksUri || authConfig.issuer;
  const cached = jwksCache.get(cacheKey);
  if (cached) {
    return cached.remoteJwks;
  }

  const jwksUri = authConfig.jwksUri ?? (await discoverJwksUri(authConfig.issuer));
  const remoteJwks = createRemoteJWKSet(new URL(jwksUri));
  jwksCache.set(cacheKey, { jwksUri, remoteJwks });
  return remoteJwks;
}

async function discoverJwksUri(issuer: string): Promise<string> {
  const candidates = [
    new URL("/.well-known/oauth-authorization-server", ensureTrailingSlash(issuer)),
    new URL("/.well-known/openid-configuration", ensureTrailingSlash(issuer)),
  ];

  for (const candidate of candidates) {
    const response = await fetch(candidate, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });

    if (response.status === 404) {
      continue;
    }

    if (!response.ok) {
      throw new Error(`Failed to discover OAuth metadata from ${candidate.origin}.`);
    }

    const metadata = await response.json() as { jwks_uri?: string };
    if (!metadata.jwks_uri) {
      throw new Error(`OAuth metadata from ${candidate.origin} did not include jwks_uri.`);
    }

    return normalizeUrl(metadata.jwks_uri, "jwks_uri");
  }

  throw new Error("Unable to discover OAuth JWKS URI.");
}

function extractScopes(payload: Record<string, unknown>): string[] {
  const scope = payload.scope;
  if (typeof scope === "string") {
    return scope.split(/\s+/).map((item) => item.trim()).filter(Boolean);
  }

  const scp = payload.scp;
  if (Array.isArray(scp)) {
    return scp.flatMap((item) => typeof item === "string" ? [item] : []);
  }

  return [];
}

function classifyOAuthFailureStage(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name.toLowerCase();
    if (name.includes("jwks")) {
      return "jwks_discovery";
    }
    if (name.includes("jwt") || name.includes("jose")) {
      return "jwt_verify";
    }
  }

  return "jwt_verify";
}

function sanitizeDiagnosticErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/g, "[redacted-jwt]");
}

