import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;

const issuerKeys = await generateKeyPair("RS256");
const publicJwk = await exportJWK(issuerKeys.publicKey);
publicJwk.kid = "console-mcp-smoke";
publicJwk.use = "sig";
publicJwk.alg = "RS256";

const issuerPort = await getFreePort();
const consolePort = await getFreePort();
const issuerOrigin = `http://127.0.0.1:${issuerPort}/`;
const issuerOriginNoSlash = issuerOrigin.slice(0, -1);
const consoleOrigin = `http://127.0.0.1:${consolePort}`;
const jwksPath = "/.well-known/jwks.json";
const jwksUri = new URL(jwksPath, issuerOrigin).toString();
const scope = "console:read";
const transcriptDir = path.join(rootDir, "var", "transcript");
const httpTracePath = path.join(transcriptDir, "http-trace.ndjson");
const oauthDebugPath = path.join(transcriptDir, "oauth-debug.ndjson");

await rm(httpTracePath, { force: true });
await rm(oauthDebugPath, { force: true });

const issuerServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Missing request URL.");
    return;
  }

  const url = new URL(req.url, issuerOrigin);
  if (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      issuer: issuerOrigin,
      jwks_uri: jwksUri,
      token_endpoint: `${issuerOriginNoSlash}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
    }));
    return;
  }

  if (url.pathname === jwksPath) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ keys: [publicJwk] }));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found.");
});

await listen(issuerServer, issuerPort);

const serverEnv = {
  ...process.env,
  CONSOLE_MCP_AUTH_MODE: "oauth",
  CONSOLE_MCP_PUBLIC_ORIGIN: consoleOrigin,
  CONSOLE_MCP_OAUTH_ISSUER: issuerOrigin,
  CONSOLE_MCP_OAUTH_AUDIENCE: consoleOrigin,
  CONSOLE_MCP_OAUTH_REQUIRED_SCOPE: scope,
  CONSOLE_MCP_OAUTH_JWKS_URI: jwksUri,
  CONSOLE_MCP_TRACE: "1",
  CONSOLE_MCP_OAUTH_DEBUG: "1",
  CONSOLE_MCP_HOST: "127.0.0.1",
  CONSOLE_MCP_PORT: String(consolePort),
  CONSOLE_MCP_MANAGED_RUNTIME: "watchdog-session-relay",
  CONSOLE_MCP_BEARER_TOKEN: "",
};

const server = spawn(node, ["dist/index.js"], {
  cwd: rootDir,
  env: serverEnv,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

const logs = [];
server.stdout.on("data", (chunk) => logs.push(String(chunk)));
server.stderr.on("data", (chunk) => logs.push(String(chunk)));

try {
  await waitForMetadata(`${consoleOrigin}/.well-known/oauth-protected-resource`);

  const metadataResponse = await fetch(`${consoleOrigin}/.well-known/oauth-protected-resource`);
  const metadata = await metadataResponse.json();
  assert(metadataResponse.status === 200, "metadata status");
  assert(!metadataResponse.headers.has("WWW-Authenticate"), "metadata is public");
  assert(metadata.resource === consoleOrigin, "metadata resource");
  assert(Array.isArray(metadata.authorization_servers) && metadata.authorization_servers.includes(issuerOrigin), "metadata authorization_servers");
  assert(Array.isArray(metadata.scopes_supported) && metadata.scopes_supported.includes(scope), "metadata scopes_supported");
  assert(Array.isArray(metadata.bearer_methods_supported) && metadata.bearer_methods_supported.includes("header"), "metadata bearer_methods_supported");

  const unauthorizedResponse = await fetch(`${consoleOrigin}/mcp`);
  const unauthorizedChallenge = unauthorizedResponse.headers.get("WWW-Authenticate") ?? "";
  assert(unauthorizedResponse.status === 401, "unauthorized status");
  assert(unauthorizedChallenge.includes(`resource_metadata="${consoleOrigin}/.well-known/oauth-protected-resource"`), "unauthorized challenge resource_metadata");
  assert(unauthorizedChallenge.includes(`scope="${scope}"`), "unauthorized challenge scope");

  const token = await new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256", kid: publicJwk.kid })
    .setIssuer(issuerOrigin)
    .setAudience(consoleOrigin)
    .setIssuedAt()
    .setNotBefore("0s")
    .setExpirationTime("5m")
    .sign(issuerKeys.privateKey);

  const transport = new StreamableHTTPClientTransport(new URL(`${consoleOrigin}/mcp`), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });

  const client = new Client({ name: "console-mcp-oauth-smoke", version: "1.0.0" });
  await client.connect(transport);

  const describe = await client.callTool({ name: "console.read_.system.console.describe", arguments: {} });
  const health = await client.callTool({ name: "console.read_.system.console.health", arguments: {} });
  const tools = await client.listTools();

  await transport.close();
  await client.close?.();

  const describeText = readTextResult(describe);
  const healthText = readTextResult(health);
  const describeTool = tools.tools.find((tool) => tool.name === "console.read_.system.console.describe");

  assert(describeText.includes("console-mcp"), "describe tool output");
  assert(healthText.includes("\"ok\": true"), "health tool output");
  assert(tools.tools.some((tool) => tool.name === "console.read_.system.console.describe"), "tool listing");
  assert(Array.isArray(describeTool?._meta?.securitySchemes), "security metadata present");
  assert(describeTool?._meta?.securitySchemes?.[0]?.type === "oauth2", "security scheme type");
  assert(Array.isArray(describeTool?._meta?.securitySchemes?.[0]?.scopes) && describeTool._meta.securitySchemes[0].scopes.includes(scope), "security scheme scope");

  const httpTrace = await readNdjson(httpTracePath);
  const oauthDebug = await readNdjson(oauthDebugPath);
  assert(httpTrace.length >= 3, "http trace entries written");
  assert(oauthDebug.length >= 1, "oauth debug entries written");
  assert(httpTrace.every((entry) => typeof entry.path === "string" && typeof entry.status_code === "number"), "http trace schema");
  assert(oauthDebug.every((entry) => entry.result === "success" || entry.result === "failure"), "oauth debug result schema");
  assert(oauthDebug.every((entry) => !Object.values(entry).some((value) => typeof value === "string" && value.includes("eyJ"))), "oauth debug redaction");

  console.log(JSON.stringify({
    ok: true,
    metadata_status: metadataResponse.status,
    unauthorized_status: unauthorizedResponse.status,
    oauth_challenge: unauthorizedChallenge,
    authenticated_tools: tools.tools.map((tool) => tool.name).sort(),
  }, null, 2));
} finally {
  await closeServer(issuerServer);
  if (!server.killed) {
    server.kill("SIGTERM");
  }
  await once(server, "exit").catch(() => undefined);
}

function assert(condition, label) {
  if (!condition) {
    throw new Error(`OAuth smoke assertion failed: ${label}`);
  }
}

function readTextResult(result) {
  const content = result.content ?? [];
  return content.map((item) => item.type === "text" ? item.text : "").join("\n");
}

async function readNdjson(filePath) {
  const text = await readFile(filePath, "utf8");
  return text.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForMetadata(url) {
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(url);
      if (response.status === 200) {
        return;
      }
    } catch {
      // retry
    }

    await delay(250);
  }

  throw new Error("console-mcp metadata endpoint did not become ready in time.");
}

async function getFreePort() {
  const server = createServer();
  await listen(server, 0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await closeServer(server);
  if (!port) {
    throw new Error("Unable to allocate a free port.");
  }

  return port;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
