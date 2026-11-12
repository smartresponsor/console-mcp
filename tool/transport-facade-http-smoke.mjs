import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
const scope = "console:write";
const transcriptDir = await mkdtemp(path.join(tmpdir(), "console-mcp-facade-smoke-"));
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
  CONSOLE_MCP_SERVER_NAME: "oauth-smoke-mcp",
  CONSOLE_MCP_PUBLIC_ORIGIN: consoleOrigin,
  CONSOLE_MCP_OAUTH_ISSUER: issuerOrigin,
  CONSOLE_MCP_OAUTH_AUDIENCE: consoleOrigin,
  CONSOLE_MCP_OAUTH_REQUIRED_SCOPE: "console:read",
  CONSOLE_MCP_OAUTH_WRITE_SCOPE: scope,
  CONSOLE_MCP_TRANSPORT_FACADE_ENABLED: "1",
  CONSOLE_MCP_REPO_FACADE_ENABLED: "1",
  CONSOLE_MCP_OAUTH_JWKS_URI: jwksUri,
  CONSOLE_MCP_TRACE: "1",
  CONSOLE_MCP_OAUTH_DEBUG: "1",
  CONSOLE_MCP_TRANSCRIPT_DIR: transcriptDir,
  CONSOLE_MCP_WORKSPACE_ROOT: transcriptDir,
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

  const unauthorizedResponse = await fetch(`${consoleOrigin}/transport/mcp`);
  const unauthorizedChallenge = unauthorizedResponse.headers.get("WWW-Authenticate") ?? "";
  assert(unauthorizedResponse.status === 401, "unauthorized status");
  assert(unauthorizedChallenge.includes(`resource_metadata="${consoleOrigin}/.well-known/oauth-protected-resource"`), "unauthorized challenge resource_metadata");
  assert(unauthorizedChallenge.includes(`scope="${scope}"`), "unauthorized challenge scope");

  const token = await new SignJWT({ scope: `console:read ${scope}` })
    .setProtectedHeader({ alg: "RS256", kid: publicJwk.kid })
    .setIssuer(issuerOrigin)
    .setAudience(consoleOrigin)
    .setIssuedAt()
    .setNotBefore("0s")
    .setExpirationTime("5m")
    .sign(issuerKeys.privateKey);

  const transport = new StreamableHTTPClientTransport(new URL(`${consoleOrigin}/transport/mcp`), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });

  const client = new Client({ name: "console-mcp-oauth-smoke", version: "1.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();

  const forbidden = await client.callTool({ name: "read_.system.console.describe", arguments: {} }).then(
    (result) => ({ denied: result.isError === true || /not found|unknown tool|not registered/i.test(JSON.stringify(result)), response: JSON.stringify(result).slice(0,1000) }),
    (error) => ({ denied: /not found|unknown tool|not registered/i.test(String(error)), error: String(error).slice(0,600) }),
  );
  assert(forbidden.denied, `non-transport tool denied: ${JSON.stringify(forbidden)}`);

  await transport.close();
  await client.close?.();

  assert(tools.tools.length === 1, "exactly one transport tool");
  assert(tools.tools[0].name === "write.transport.json.artifact", "only canonical transport tool");
  const transportTool = tools.tools[0];
  assert(Array.isArray(transportTool?._meta?.securitySchemes), "security metadata present");
  assert(transportTool?._meta?.securitySchemes?.[0]?.type === "oauth2", "security scheme type");
  assert(transportTool?._meta?.securitySchemes?.[0]?.scopes?.includes(scope), "write scope metadata");

  // The original MCP route must retain its full canonical projection.
  const canonicalTransport = new StreamableHTTPClientTransport(new URL(`${consoleOrigin}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const canonicalClient = new Client({ name: "canonical-route-regression", version: "1.0.0" });
  await canonicalClient.connect(canonicalTransport);
  const canonicalTools = await canonicalClient.listTools();
  assert(canonicalTools.tools.some((tool) => tool.name === "read_.system.console.describe"), "canonical route retains describe");
  assert(canonicalTools.tools.length > 1, "canonical route retains full projection");
  await canonicalTransport.close();
  await canonicalClient.close?.();

  const readToken = await new SignJWT({ scope: "console:read" })
    .setProtectedHeader({ alg: "RS256", kid: publicJwk.kid })
    .setIssuer(issuerOrigin).setAudience(consoleOrigin).setIssuedAt().setExpirationTime("5m")
    .sign(issuerKeys.privateKey);
  const readResponse = await fetch(`${consoleOrigin}/transport/mcp`, {
    method: "POST", headers: { Authorization: `Bearer ${readToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  // The canonical MCP endpoint must reject a write tool with a valid read-only JWT.
  const canonicalWriteDenied = await fetch(`${consoleOrigin}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${readToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 991, method: "tools/call",
      params: { name: "write.repo.git.worktree.create", arguments: {} },
    }),
  });
  assert(canonicalWriteDenied.status === 403, "canonical write denied for read-only token");
  assert((canonicalWriteDenied.headers.get("WWW-Authenticate") ?? "").includes('error="insufficient_scope"'), "canonical write insufficient_scope challenge");
  const canonicalWriteDenialBody = await canonicalWriteDenied.json();
  assert(canonicalWriteDenialBody.error?.code === -32003, "canonical write scope denial code");

  // Reject unknown tool names before dispatch, even with a valid read-scoped JWT.
  const canonicalUnknownDenied = await fetch(`${consoleOrigin}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${readToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 993, method: "tools/call",
      params: { name: "read_.nonexistent.security.probe", arguments: {} },
    }),
  });
  assert(canonicalUnknownDenied.status === 403, "unknown canonical tool denied before dispatch");
  assert((await canonicalUnknownDenied.json()).error?.code === -32003, "unknown canonical tool denial code");

  // A mixed batch must fail atomically at the scope gate, not dispatch the read item first.
  const canonicalMixedBatchDenied = await fetch(`${consoleOrigin}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${readToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify([
      { jsonrpc: "2.0", id: 994, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 995, method: "tools/call",
        params: { name: "write.repo.git.worktree.create", arguments: {} } },
    ]),
  });
  assert(canonicalMixedBatchDenied.status === 403, "mixed batch containing write denied atomically");
  assert((await canonicalMixedBatchDenied.json()).error?.code === -32003, "mixed batch scope denial code");

  // Missing or malformed names must fail closed rather than reach the MCP dispatcher.
  for (const [id, params] of [
    [996, {}],
    [997, { name: 123, arguments: {} }],
    [998, { name: "", arguments: {} }],
  ]) {
    const malformedResponse = await fetch(`${consoleOrigin}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${readToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params }),
    });
    assert(malformedResponse.status === 403, `malformed tool name denied (id=${id})`);
    assert((await malformedResponse.json()).error?.code === -32003, `malformed tool name denial code (id=${id})`);
  }

  // A read tool on the canonical endpoint must not be rejected by the scope gate.
  const canonicalReadAllowed = await fetch(`${consoleOrigin}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${readToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 992, method: "tools/list", params: {} }),
  });
  assert(canonicalReadAllowed.status === 200, "canonical tools/list allowed for read-only token");

  assert(readResponse.status === 401, "read-scoped token denied");
  assert((readResponse.headers.get("WWW-Authenticate") ?? "").includes('scope="console:write"'), "write scope challenge");

  // Repo facade is a strict eight-tool OAuth write-scoped projection.
  const repoTransport = new StreamableHTTPClientTransport(new URL(`${consoleOrigin}/repo/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const repoClient = new Client({ name: "repo-facade-regression", version: "1.0.0" });
  await repoClient.connect(repoTransport);
  const repoTools = await repoClient.listTools();
  const expectedRepoTools = [
    "write.repo.git.merge.reviewed",
    "write.repo.git.archive.ref.push",
    "write.repo.git.push.current.branch",
    "write.repo.git.branch.push",
    "write.repo.git.safe.directory.add",
    "write.repo.git.worktree.create",
    "read_.repo.git.worktree.list",
    "write.repo.git.worktree.remove",
  ].sort();
  assert(JSON.stringify(repoTools.tools.map((tool) => tool.name).sort()) === JSON.stringify(expectedRepoTools), "exact repo facade tool projection");
  assert(repoTools.tools.filter((tool) => tool.name.startsWith("write.")).every((tool) => tool._meta?.securitySchemes?.[0]?.scopes?.includes(scope)), "repo mutation tools advertise write scope");
  assert(repoTools.tools.find((tool) => tool.name === "read_.repo.git.worktree.list")?._meta?.securitySchemes?.[0]?.scopes?.includes("console:read"), "canonical read tool metadata retained; facade endpoint separately enforces write scope");
  const forbiddenRepo = await repoClient.callTool({ name: "read_.system.console.describe", arguments: {} }).then(
    (result) => result.isError === true || /not found|unknown tool|not registered/i.test(JSON.stringify(result)),
    (error) => /not found|unknown tool|not registered/i.test(String(error)),
  );
  assert(forbiddenRepo, "non-repo tool denied");
  await repoTransport.close();
  await repoClient.close?.();

  const repoReadResponse = await fetch(`${consoleOrigin}/repo/mcp`, {
    method: "POST", headers: { Authorization: `Bearer ${readToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  assert(repoReadResponse.status === 401, "repo read-scoped token denied");
  assert((repoReadResponse.headers.get("WWW-Authenticate") ?? "").includes('scope="console:write"'), "repo write scope challenge");

  const httpTrace = await readNdjson(httpTracePath);
  const oauthDebug = await readNdjson(oauthDebugPath);
  assert(httpTrace.length >= 3, "http trace entries written");
  assert(oauthDebug.length >= 1, "oauth debug entries written");
  assert(httpTrace.every((entry) => typeof entry.path === "string" && typeof entry.status_code === "number"), "http trace schema");
  assert(oauthDebug.every((entry) => entry.result === "success" || entry.result === "failure"), "oauth debug result schema");
  assert(oauthDebug.every((entry) => !Object.values(entry).some((value) => typeof value === "string" && value.includes("eyJ"))), "oauth debug redaction");

  // Disabled-by-default regression: an isolated second OAuth process must not publish /repo/mcp.
  const disabledPort = await getFreePort();
  const disabledOrigin = `http://127.0.0.1:${disabledPort}`;
  const disabledServer = spawn(node, ["dist/index.js"], {
    cwd: rootDir,
    env: {
      ...serverEnv,
      CONSOLE_MCP_TRANSPORT_FACADE_ENABLED: "0",
      CONSOLE_MCP_REPO_FACADE_ENABLED: "0",
      CONSOLE_MCP_PORT: String(disabledPort),
      CONSOLE_MCP_PUBLIC_ORIGIN: disabledOrigin,
      CONSOLE_MCP_OAUTH_AUDIENCE: disabledOrigin,
      CONSOLE_MCP_TRACE: "0",
      CONSOLE_MCP_OAUTH_DEBUG: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const disabledLogs = [];
  disabledServer.stdout.on("data", (chunk) => disabledLogs.push(String(chunk)));
  disabledServer.stderr.on("data", (chunk) => disabledLogs.push(String(chunk)));
  try {
    let ready = false;
    for (let i = 0; i < 80; i += 1) {
      if (disabledServer.exitCode !== null || disabledServer.signalCode !== null) break;
      try {
        const response = await fetch(`${disabledOrigin}/.well-known/oauth-protected-resource`);
        if (response.status === 200) { ready = true; break; }
      } catch {}
      await delay(250);
    }
    assert(ready, `disabled facade server ready: ${disabledLogs.join("")}`);
    const disabledToken = await new SignJWT({ scope: "console:read console:write" })
      .setProtectedHeader({ alg: "RS256", kid: publicJwk.kid })
      .setIssuer(issuerOrigin).setAudience(disabledOrigin).setIssuedAt().setExpirationTime("5m")
      .sign(issuerKeys.privateKey);
    const disabledHeaders = { Authorization: `Bearer ${disabledToken}`, "Content-Type": "application/json" };
    const disabledTransportResponse = await fetch(`${disabledOrigin}/transport/mcp`, {
      method: "POST", headers: disabledHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    });
    assert(disabledTransportResponse.status === 404, "disabled transport facade route returns 404");
    const disabledFacadeResponse = await fetch(`${disabledOrigin}/repo/mcp`, {
      method: "POST", headers: disabledHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }),
    });
    assert(disabledFacadeResponse.status === 404, "disabled repo facade route returns 404");
    const disabledCanonicalResponse = await fetch(`${disabledOrigin}/mcp`, {
      method: "POST", headers: { ...disabledHeaders, Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} }),
    });
    assert(disabledCanonicalResponse.status === 200, "disabled facades leave canonical route operational");
  } finally {
    if (!disabledServer.killed) disabledServer.kill("SIGTERM");
    if (disabledServer.exitCode === null && disabledServer.signalCode === null) {
      await once(disabledServer, "exit").catch(() => undefined);
    }
  }

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
  if (server.exitCode === null && server.signalCode === null) {
    await once(server, "exit").catch(() => undefined);
  }
  await rm(transcriptDir, { recursive: true, force: true });
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
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`OAuth smoke server exited (code=${server.exitCode}, signal=${server.signalCode}).\n${logs.join("")}`);
    }
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

  throw new Error(`console-mcp metadata endpoint did not become ready in time.\n${logs.join("")}`);
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
