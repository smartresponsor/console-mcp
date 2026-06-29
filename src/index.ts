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
import { registerGoogleAdsEditorTools } from "./tool/google-ads-editor.js";
import { registerGitInspectionTools } from "./tool/git-inspection.js";
import { registerQaTools } from "./tool/qa.js";
import { registerLocalhostTool } from "./tool/localhost.js";
import { registerLocalCurlTool } from "./tool/local-curl.js";
import { registerBrowserSessionTool } from "./tool/browser-session.js";
import { registerMobileEdgeServerTool } from "./tool/mobile-edge-server.js";
import { registerDatabaseTools } from "./tool/database.js";
import { registerAskTool } from "./tool/ask.js";
import { registerRcTool } from "./tool/rc.js";
import { registerCacheMaintenanceTools as registerRuntimeMaintenanceTools } from "./tool/cache-maintenance.js";

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
  const mcpServer = buildServer(policy, projectRoot);

  try {
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
    res.on("close", () => {
      void transport.close();
      void mcpServer.close();
    });
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
  registerGoogleAdsEditorTools(mcpServer, authConfig);
  registerGitInspectionTools(mcpServer, policySnapshot, authConfig);
  registerQaTools(mcpServer, policySnapshot, authConfig);
  registerLocalhostTool(mcpServer, policySnapshot, authConfig);
  registerLocalCurlTool(mcpServer, policySnapshot, authConfig);
  registerBrowserSessionTool(mcpServer, authConfig);
  registerMobileEdgeServerTool(mcpServer, policySnapshot, authConfig);
  registerDatabaseTools(mcpServer, policySnapshot, authConfig);
  registerAskTool(mcpServer, policySnapshot, baseDir, authConfig);
  registerRcTool(mcpServer, policySnapshot, authConfig);
  registerRuntimeMaintenanceTools(mcpServer, policySnapshot, authConfig);

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
