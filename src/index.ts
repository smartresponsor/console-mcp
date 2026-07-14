import { createServer } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConsolePolicy } from "./Policy/ConsolePolicy.js";
import { authorizeRequest, buildProtectedResourceMetadata, buildUnauthorizedChallenge, isOAuthProtectedResourceMetadataRequest, loadConsoleAuthConfigForMode, type ConsoleAuthConfig } from "./Security/Auth/ConsoleAuth.js";
import { buildHttpTraceRecord, isTraceEnabled, recordHttpTrace } from "./Infrastructure/Diagnostics/RuntimeDiagnostics.js";
import { CanonicalToolRegistry, createConsumerFilteredServer, type ConsumerName, type ConsumerToolProjection } from "./engine/canonical-tool-registry.js";
import type { ConsoleRuntimeInfo } from "./tool/health.js";
import { registerDescribeTool } from "./tool/describe.js";
import { registerHealthTool } from "./tool/health.js";
import { registerWorkspaceStatusTool } from "./tool/workspace-status.js";
import { registerCaptureContextTool } from "./tool/capture-context.js";
import { registerReadFileTool } from "./tool/read-file.js";
import { registerSearchTextTool } from "./tool/search-text.js";
import { registerRunCheckTool } from "./tool/run-check.js";
import { registerWorkspaceScopeTools } from "./tool/workspace-scope.js";
import { registerOrchestrationDocsTool } from "./tool/orchestration-docs.js";
import { registerApplyPatchTool } from "./tool/apply-patch.js";
import { registerReplaceInFileTool } from "./tool/replace-in-file.js";
import { registerGoogleAdsEditorTools } from "./tool/google-ads-editor.js";
import { registerGitInspectionTools } from "./tool/git-inspection.js";
import { registerGitHubWorkflowTools } from "./tool/github-workflow.js";
import { registerQaTools } from "./tool/qa.js";
import { registerLocalhostTool } from "./tool/localhost.js";
import { registerLocalCurlTool } from "./tool/local-curl.js";
import { registerBrowserSessionTool } from "./tool/browser-session.js";
import { registerMobileEdgeServerTool } from "./tool/mobile-edge-server.js";
import { registerDevConsoleCommandTool } from "./tool/dev-console-command.js";
import { registerLocalPhpServerTool } from "./tool/local-php-server.js";
import { registerDatabaseTools } from "./tool/database.js";
import { registerAskTool } from "./tool/ask.js";
import { registerRcTool } from "./tool/rc.js";
import { registerRuntimeMaintenanceTools } from "./tool/runtime-maintenance.js";
import { registerChatGptArtifactGuardTools } from "./tool/chatgpt-artifact-guard.js";
import { registerChatGptMessageCaptureTool } from "./tool/chatgpt-message-capture.js";
import { registerChatGptGuardSnapshotTool } from "./tool/chatgpt-guard-snapshot.js";
import { registerChatGptChatOpenTool } from "./tool/chatgpt-chat-open.js";
import { registerChatGptEntrypointPlanTool } from "./tool/chatgpt-entrypoint-plan.js";
import { registerImplementationRunCaptureTool } from "./tool/implementation-run-capture.js";
import { registerEngineTools } from "./tool/engine.js";

const normalizedPath = process.env.PATH ?? process.env.Path ?? process.env.path;
if (normalizedPath && !process.env.PATH) {
  process.env.PATH = normalizedPath;
}
if (normalizedPath && !process.env.Path) {
  process.env.Path = normalizedPath;
}

const projectRoot = path.resolve(process.cwd());
const policy = await loadConsolePolicy(projectRoot);

type RuntimeProfile = {
  name: "chatgpt-oauth" | "codex-bearer";
  consumer: ConsumerName;
  host: string;
  port: number;
  authConfig: ConsoleAuthConfig;
};

type RuntimeProfileCandidate = {
  name: RuntimeProfile["name"];
  consumer: ConsumerName;
  host: string;
  port: number;
  mode: ConsoleAuthConfig["mode"];
};

// Both profiles are declared unconditionally - this process is able to serve ChatGPT (oauth,
// :3333) and Codex (bearer, :3334) from a single Node process when the environment for both is
// present. Today tool/dev-console.ps1 still starts each profile with only its own environment
// (see Start-ChatgptOauth/Start-CodexBearer), so in practice exactly one profile's config loads
// and the other is skipped below rather than crashing the whole process - preserving today's
// two-independent-processes operational model while this stays forward-compatible with a future
// single-process launch that supplies both.
const explicitAuthMode = process.env.CONSOLE_MCP_AUTH_MODE?.trim().toLowerCase();
const PROFILE_CANDIDATES: RuntimeProfileCandidate[] = explicitAuthMode === "oauth"
  ? [{ name: "chatgpt-oauth", consumer: "chatgpt", host: policy.host, port: policy.port, mode: "oauth" }]
  : explicitAuthMode === "bearer"
    ? [{ name: "codex-bearer", consumer: "codex", host: policy.host, port: policy.port, mode: "bearer" }]
    : [
      { name: "chatgpt-oauth", consumer: "chatgpt", host: policy.host, port: 3333, mode: "oauth" },
      { name: "codex-bearer", consumer: "codex", host: "127.0.0.1", port: 3334, mode: "bearer" },
    ];

const profiles: RuntimeProfile[] = [];
for (const candidate of PROFILE_CANDIDATES) {
  try {
    const authConfig = loadConsoleAuthConfigForMode(candidate.mode);
    profiles.push({ name: candidate.name, consumer: candidate.consumer, host: candidate.host, port: candidate.port, authConfig });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`console-mcp: skipping ${candidate.name} profile - ${message}`);
  }
}

if (profiles.length === 0) {
  console.error("console-mcp refuses to start: no runtime profile has a valid configuration.");
  process.exit(1);
}

// Recording pass to compute the canonical tool registry once at startup: this does not depend on
// which profiles above actually loaded, and its authConfig is a throwaway value that is never
// used to serve real requests (registration calls only read authConfig.mode / fields to build
// each tool's static config, never to authorize anything).
const canonicalRegistryProbeAuth: ConsoleAuthConfig = { mode: "bearer", bearerTokens: ["canonical-registry-recording-pass"] };
const canonicalRegistry = CanonicalToolRegistry.build((sink) => registerAllTools(sink, policy, projectRoot, canonicalRegistryProbeAuth));
const consumerProjections = canonicalRegistry.forAllConsumers();

const buildFingerprint = crypto.createHash("sha256")
  .update(fs.readFileSync(fileURLToPath(import.meta.url)))
  .digest("hex")
  .slice(0, 16);

const runtimeInfo: ConsoleRuntimeInfo = {
  buildFingerprint,
  canonicalRegistryFingerprint: canonicalRegistry.fingerprint,
  consumers: {
    chatgpt: { toolCount: consumerProjections.chatgpt.toolCount, schemaFingerprint: consumerProjections.chatgpt.schemaFingerprint },
    codex: { toolCount: consumerProjections.codex.toolCount, schemaFingerprint: consumerProjections.codex.schemaFingerprint },
  },
};

function createProfileServer(profile: RuntimeProfile) {
  const { host, port, authConfig, consumer } = profile;
  const policySnapshot = { ...policy, host, port };

  const server = createServer(async (req, res) => {
  const requestStartedAt = Date.now();
  const requestUrl = req.url ? new URL(req.url, `http://${req.headers.host ?? `${host}:${port}`}`) : null;
  const tracePath = requestUrl?.pathname ?? "";
  let traceWritten = false;
  const finalizeTrace = () => {
    if (traceWritten || !isTraceEnabled()) {
      return;
    }

    traceWritten = true;
    void recordHttpTrace(
      policy.transcriptDir,
      buildHttpTraceRecord(
        req,
        tracePath,
        authConfig.mode,
        res.statusCode,
        Date.now() - requestStartedAt,
      ),
    );
  };

  res.once("finish", finalizeTrace);
  res.once("close", finalizeTrace);

  if (!req.url) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Missing request URL.");
    return;
  }

  const url = requestUrl;
  if (!url) {
    return;
  }

  const metadataResponse = handleProtectedResourceMetadataRequest(req, res, url, authConfig);
  if (metadataResponse.handled) {
    return;
  }

  const authorizationServerMetadataResponse = handleAuthorizationServerMetadataRequest(req, res, url, authConfig);
  if (authorizationServerMetadataResponse.handled) {
    return;
  }

  const decision = await authorizeRequest(req, authConfig, policy.transcriptDir);
  if (!decision.authorized) {
    const headers: Record<string, string> = {
      "Content-Type": "text/plain; charset=utf-8",
    };
    if (authConfig.mode === "oauth") {
      headers["WWW-Authenticate"] = buildUnauthorizedChallenge(authConfig);
    }
    res.writeHead(401, headers);
    res.end("Unauthorized.");
    return;
  }

  if (url.pathname !== policy.endpoint) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found.");
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, {
      "Content-Type": "application/json; charset=utf-8",
      Allow: "POST",
    });
    res.end(JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    }));
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  let mcpServer: McpServer | null = null;
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    void transport.close();
    void mcpServer?.close();
  };

  res.once("finish", cleanup);
  res.once("close", cleanup);

  try {
    mcpServer = buildServer(policySnapshot, projectRoot, authConfig, consumer);
    await mcpServer.connect(transport);
    const body = await readJsonBody(req);
    recordToolsListAudit(body, consumer, req, consumerProjections[consumer], policy.transcriptDir);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
        id: null,
      }));
    }
  } finally {
    cleanup();
  }
  });

  server.on("error", (error: NodeJS.ErrnoException) => {
    console.error(error.code === "EADDRINUSE"
      ? `console-mcp failed to start ${profile.name}: ${host}:${port} is already in use.`
      : `console-mcp failed to start ${profile.name} on ${host}:${port}: ${error.message}`);
    closeServersAndExit(1);
  });

  return server;
}

const servers = profiles.map(createProfileServer);

for (const [index, server] of servers.entries()) {
  const profile = profiles[index];
  server.listen(profile.port, profile.host, () => {
    console.log(`console-mcp ${profile.name} listening on http://${profile.host}:${profile.port}${policy.endpoint}`);
  });
}

let shuttingDown = false;

function closeServersAndExit(exitCode: number) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  let pending = servers.length;

  for (const server of servers) {
    server.close(() => {
      pending -= 1;
      if (pending === 0) {
        process.exit(exitCode);
      }
    });
  }
}

process.on("SIGINT", () => closeServersAndExit(0));
process.on("SIGTERM", () => closeServersAndExit(0));

function buildServer(policySnapshot: typeof policy, baseDir: string, authConfig: ConsoleAuthConfig, consumer: ConsumerName): McpServer {
  const mcpServer = new McpServer({
    name: policySnapshot.serverName,
    version: policySnapshot.version,
  });

  const filteredServer = createConsumerFilteredServer(mcpServer, consumerProjections[consumer]);
  registerAllTools(filteredServer, policySnapshot, baseDir, authConfig, runtimeInfo);

  return mcpServer;
}

function registerAllTools(mcpServer: McpServer, policySnapshot: typeof policy, baseDir: string, authConfig: ConsoleAuthConfig, healthRuntimeInfo?: ConsoleRuntimeInfo): void {
  registerDescribeTool(mcpServer, policySnapshot, authConfig);
  registerHealthTool(mcpServer, policySnapshot, authConfig, healthRuntimeInfo);
  registerWorkspaceStatusTool(mcpServer, policySnapshot, authConfig);
  registerCaptureContextTool(mcpServer, policySnapshot, baseDir, authConfig);
  registerReadFileTool(mcpServer, policySnapshot, authConfig);
  registerSearchTextTool(mcpServer, policySnapshot, authConfig);
  registerRunCheckTool(mcpServer, policySnapshot, baseDir, authConfig);
  registerWorkspaceScopeTools(mcpServer, policySnapshot, authConfig);
  registerOrchestrationDocsTool(mcpServer, policySnapshot, baseDir, authConfig);
  registerApplyPatchTool(mcpServer, policySnapshot, authConfig);
  registerReplaceInFileTool(mcpServer, policySnapshot, authConfig);
  registerGoogleAdsEditorTools(mcpServer, authConfig);
  registerGitInspectionTools(mcpServer, policySnapshot, authConfig);
  registerGitHubWorkflowTools(mcpServer, policySnapshot, baseDir, authConfig);
  registerQaTools(mcpServer, policySnapshot, authConfig);
  registerLocalhostTool(mcpServer, policySnapshot, authConfig);
  registerLocalCurlTool(mcpServer, policySnapshot, authConfig);
  registerBrowserSessionTool(mcpServer, authConfig);
  registerMobileEdgeServerTool(mcpServer, policySnapshot, authConfig);
  registerDevConsoleCommandTool(mcpServer, policySnapshot, authConfig);
  registerLocalPhpServerTool(mcpServer, policySnapshot, authConfig);
  registerDatabaseTools(mcpServer, policySnapshot, authConfig);
  registerAskTool(mcpServer, policySnapshot, baseDir, authConfig);
  registerRcTool(mcpServer, policySnapshot, authConfig);
  registerRuntimeMaintenanceTools(mcpServer, policySnapshot, authConfig);
  registerChatGptArtifactGuardTools(mcpServer, authConfig);
  registerChatGptMessageCaptureTool(mcpServer, authConfig);
  registerChatGptGuardSnapshotTool(mcpServer, authConfig);
  registerChatGptChatOpenTool(mcpServer, policySnapshot, baseDir, authConfig);
  registerChatGptEntrypointPlanTool(mcpServer, policySnapshot, authConfig);
  registerImplementationRunCaptureTool(mcpServer, policySnapshot, baseDir, authConfig);
  registerEngineTools(mcpServer, policySnapshot, baseDir, authConfig);
}

let toolsListAuditSequence = 0;

function recordToolsListAudit(body: unknown, consumer: ConsumerName, req: IncomingMessage, projection: ConsumerToolProjection, transcriptDir: string): void {
  const requests = (Array.isArray(body) ? body : [body])
    .filter((item): item is { method?: unknown; id?: unknown } => typeof item === "object" && item !== null);
  const timestamp = new Date().toISOString();
  const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
  const auditDir = path.join(transcriptDir, "schema-audit");
  fs.mkdirSync(auditDir, { recursive: true });

  for (const request of requests) {
    const method = typeof request.method === "string" ? request.method : null;
    if (!method) {
      continue;
    }
    const methodRecord = {
      timestamp,
      consumer,
      method,
      request_id: typeof request.id === "string" || typeof request.id === "number" ? request.id : null,
      user_agent: userAgent,
    };
    fs.appendFileSync(path.join(auditDir, "mcp-methods.ndjson"), `${JSON.stringify(methodRecord)}\n`, "utf8");

    if (method !== "tools/list") {
      continue;
    }
    const toolNames = [...projection.toolNames].sort();
    const record = {
      ...methodRecord,
      observed_at_unix_ms: Date.now(),
      sequence: ++toolsListAuditSequence,
      tool_count: toolNames.length,
      schema_fingerprint: projection.schemaFingerprint,
      has_adopt_go: toolNames.includes("console.write.browser.chatgpt.chat.adopt_go"),
      has_adopt_into_task_bank: toolNames.includes("console.write.browser.chatgpt.chat.adopt_into_task_bank"),
      tool_names: toolNames,
    };
    fs.writeFileSync(path.join(auditDir, `last-tools-list-${consumer}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return undefined;
  }

  return JSON.parse(raw);
}

function handleAuthorizationServerMetadataRequest(req: IncomingMessage, res: import("node:http").ServerResponse, url: URL, authConfig: ConsoleAuthConfig): { handled: true } | { handled: false } { if (authConfig.mode !== "oauth" || url.pathname !== "/.well-known/oauth-authorization-server") { return { handled: false }; } if (req.method !== "GET") { res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET" }); res.end("Method Not Allowed."); return { handled: true }; } const issuer = authConfig.issuer.endsWith("/") ? authConfig.issuer : authConfig.issuer + "/"; const metadata = { issuer, authorization_endpoint: new URL("/authorize", issuer).toString(), token_endpoint: new URL("/oauth/token", issuer).toString(), jwks_uri: authConfig.jwksUri ?? new URL("/.well-known/jwks.json", issuer).toString(), registration_endpoint: new URL("/oidc/register", issuer).toString(), scopes_supported: Array.from(new Set(["openid", "email", authConfig.readScope, authConfig.writeScope])), response_types_supported: ["code"], response_modes_supported: ["query"], grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"], code_challenge_methods_supported: ["S256"] }; res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" }); res.end(JSON.stringify(metadata) + "\n"); return { handled: true }; }

function handleProtectedResourceMetadataRequest(
  req: IncomingMessage,
  res: import("node:http").ServerResponse,
  url: URL,
  authConfig: ConsoleAuthConfig,
): { handled: true } | { handled: false } {
  if (!isOAuthProtectedResourceMetadataRequest(url, authConfig)) {
    return { handled: false };
  }

  if (req.method !== "GET") {
    res.writeHead(405, {
      "Content-Type": "application/json; charset=utf-8",
      Allow: "GET",
    });
    res.end(JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    }));
    return { handled: true };
  }

  const metadata = buildProtectedResourceMetadata(authConfig);
  if (!metadata) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found.");
    return { handled: true };
  }

  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(metadata));
  return { handled: true };
}

