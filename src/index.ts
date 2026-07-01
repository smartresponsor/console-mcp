import { createServer } from "node:http";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConsolePolicy } from "./service/policy.js";
import { authorizeRequest, buildProtectedResourceMetadata, buildUnauthorizedChallenge, isOAuthProtectedResourceMetadataRequest, loadConsoleAuthConfig, type ConsoleAuthConfig } from "./service/auth.js";
import { buildHttpTraceRecord, isTraceEnabled, recordHttpTrace } from "./service/diagnostics.js";
import { registerDescribeTool } from "./tool/describe.js";
import { registerHealthTool } from "./tool/health.js";
import { registerWorkspaceStatusTool } from "./tool/workspace-status.js";
import { registerCaptureContextTool } from "./tool/capture-context.js";
import { registerReadFileTool } from "./tool/read-file.js";
import { registerSearchTextTool } from "./tool/search-text.js";
import { registerRunCheckTool } from "./tool/run-check.js";
import { registerApplyPatchTool } from "./tool/apply-patch.js";
import { registerReplaceInFileTool } from "./tool/replace-in-file.js";
import { registerGoogleAdsEditorTools } from "./tool/google-ads-editor.js";
import { registerGitInspectionTools } from "./tool/git-inspection.js";
import { registerQaTools } from "./tool/qa.js";
import { registerLocalhostTool } from "./tool/localhost.js";
import { registerLocalCurlTool } from "./tool/local-curl.js";
import { registerBrowserSessionTool } from "./tool/browser-session.js";
import { registerMobileEdgeServerTool } from "./tool/mobile-edge-server.js";
import { registerLocalPhpServerTool } from "./tool/local-php-server.js";
import { registerDatabaseTools } from "./tool/database.js";
import { registerAskTool } from "./tool/ask.js";
import { registerRcTool } from "./tool/rc.js";
import { registerRuntimeMaintenanceTools } from "./tool/runtime-maintenance.js";
import { registerChatGptArtifactGuardTools } from "./tool/chatgpt-artifact-guard.js";
import { registerChatGptMessageCaptureTool } from "./tool/chatgpt-message-capture.js";
import { registerChatGptGuardSnapshotTool } from "./tool/chatgpt-guard-snapshot.js";
import { registerChatGptPromptDraftTool } from "./tool/chatgpt-prompt-draft.js";

const normalizedPath = process.env.PATH ?? process.env.Path ?? process.env.path;
if (normalizedPath && !process.env.PATH) {
  process.env.PATH = normalizedPath;
}
if (normalizedPath && !process.env.Path) {
  process.env.Path = normalizedPath;
}

const projectRoot = path.resolve(process.cwd());
const policy = await loadConsolePolicy(projectRoot);
let authConfig: ConsoleAuthConfig;

try {
  authConfig = loadConsoleAuthConfig();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}

const host = policy.host;
const port = policy.port;

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
    mcpServer = buildServer(policy, projectRoot);
    await mcpServer.connect(transport);
    const body = await readJsonBody(req);
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

server.listen(port, host, () => {
  console.log(`console-mcp listening on http://${host}:${port}${policy.endpoint}`);
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});

function buildServer(policySnapshot: typeof policy, baseDir: string): McpServer {
  const mcpServer = new McpServer({
    name: policySnapshot.serverName,
    version: policySnapshot.version,
  });

  registerDescribeTool(mcpServer, policySnapshot, authConfig);
  registerHealthTool(mcpServer, policySnapshot, authConfig);
  registerWorkspaceStatusTool(mcpServer, policySnapshot, authConfig);
  registerCaptureContextTool(mcpServer, policySnapshot, baseDir, authConfig);
  registerReadFileTool(mcpServer, policySnapshot, authConfig);
  registerSearchTextTool(mcpServer, policySnapshot, authConfig);
  registerRunCheckTool(mcpServer, policySnapshot, baseDir, authConfig);
  registerApplyPatchTool(mcpServer, policySnapshot, authConfig);
  registerReplaceInFileTool(mcpServer, policySnapshot, authConfig);
  registerGoogleAdsEditorTools(mcpServer, authConfig);
  registerGitInspectionTools(mcpServer, policySnapshot, authConfig);
  registerQaTools(mcpServer, policySnapshot, authConfig);
  registerLocalhostTool(mcpServer, policySnapshot, authConfig);
  registerLocalCurlTool(mcpServer, policySnapshot, authConfig);
  registerBrowserSessionTool(mcpServer, authConfig);
  registerMobileEdgeServerTool(mcpServer, policySnapshot, authConfig);
  registerLocalPhpServerTool(mcpServer, policySnapshot, authConfig);
  registerDatabaseTools(mcpServer, policySnapshot, authConfig);
  registerAskTool(mcpServer, policySnapshot, baseDir, authConfig);
  registerRcTool(mcpServer, policySnapshot, authConfig);
  registerRuntimeMaintenanceTools(mcpServer, policySnapshot, authConfig);
  registerChatGptArtifactGuardTools(mcpServer, authConfig);
  registerChatGptMessageCaptureTool(mcpServer, authConfig);
  registerChatGptGuardSnapshotTool(mcpServer, authConfig);
  registerChatGptPromptDraftTool(mcpServer, authConfig);

  return mcpServer;
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
