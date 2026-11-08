import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const cases = {
  repo: { count: 69, call: "read_.repo.git.worktree.list", args: { workspacePath: process.cwd() } },
};
const group = process.argv[2];
const expected = cases[group];
assert.ok(expected, `unknown facade regression group: ${group}`);
const admission = JSON.parse(await readFile(new URL("../policy/console-tool-admission.json", import.meta.url), "utf8"));
const expectedNames = admission.declarations
  .filter((entry) => entry.consumers.includes("chatgpt") && entry.lifecycle !== "retired" && new RegExp(`^(?:read_|write)\\.${group}\\.`).test(entry.name))
  .map((entry) => entry.name).sort();
assert.equal(expectedNames.length, expected.count, `unexpected admitted ${group} inventory`);

const temp = await mkdtemp(path.join(os.tmpdir(), `console-mcp-${group}-facade-`));
const oauthPort = await freePort();
const jwksPort = await freePort();
const bearerPort = await freePort();
const issuer = `http://127.0.0.1:${jwksPort}/`;
const audience = `http://127.0.0.1:${oauthPort}`;
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = await exportJWK(publicKey); jwk.kid = "facade-test"; jwk.use = "sig"; jwk.alg = "RS256";
const jwks = http.createServer((req, res) => {
  if (req.url === "/jwks") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ keys: [jwk] })); return; }
  res.writeHead(404); res.end();
});
await new Promise((resolve) => jwks.listen(jwksPort, "127.0.0.1", resolve));
const token = await new SignJWT({ scope: "console:read console:write" })
  .setProtectedHeader({ alg: "RS256", kid: jwk.kid }).setIssuer(issuer).setAudience(audience)
  .setIssuedAt().setExpirationTime("5m").sign(privateKey);

let oauth;
let bearer;
try {
  oauth = await startRuntime(oauthPort, temp, {
    CONSOLE_MCP_AUTH_MODE: "oauth", CONSOLE_MCP_PUBLIC_ORIGIN: audience,
    CONSOLE_MCP_OAUTH_ISSUER: issuer, CONSOLE_MCP_OAUTH_AUDIENCE: audience,
    CONSOLE_MCP_OAUTH_JWKS_URI: `${issuer}jwks`, CONSOLE_MCP_OAUTH_REQUIRED_SCOPE: "console:read",
  });
  const metadata = await fetch(`${audience}/.well-known/oauth-protected-resource`);
  assert.equal(metadata.status, 200); assert.equal((await metadata.json()).resource, audience);
  const unauthorized = await mcp(oauthPort, `/mcp/${group}`, { method: "tools/list", id: 1 });
  assert.equal(unauthorized.status, 401); assert.match(unauthorized.headers.get("www-authenticate") ?? "", /resource_metadata=/);
  const headers = { authorization: `Bearer ${token}` };
  const initialized = await mcp(oauthPort, `/mcp/${group}`, { method: "initialize", id: 2, params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "facade-regression", version: "1" } } }, headers);
  assert.equal(initialized.status, 200); assert.ok(initialized.body.result?.protocolVersion);
  const listed = await mcp(oauthPort, `/mcp/${group}`, { method: "tools/list", id: 3 }, headers);
  assert.equal(listed.status, 200);
  const tools = listed.body.result.tools;
  assert.deepEqual(tools.map((tool) => tool.name).sort(), expectedNames);
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })).sort((a, b) => a.name.localeCompare(b.name)))).digest("hex").slice(0, 16);
  assert.match(fingerprint, /^[0-9a-f]{16}$/);
  const called = await mcp(oauthPort, `/mcp/${group}`, { method: "tools/call", id: 4, params: { name: expected.call, arguments: expected.args } }, headers);
  assert.equal(called.status, 200); assert.ok(called.body.result && !called.body.error, JSON.stringify(called.body));
  const baseline = await mcp(oauthPort, "/mcp", { method: "tools/list", id: 5 }, headers);
  assert.equal(baseline.status, 200); assert.ok(baseline.body.result.tools.length > tools.length);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const auditFiles = await readdir(temp, { recursive: true });
  assert.ok(auditFiles.length > 0, "facade requests must retain canonical audit output");

  bearer = await startRuntime(bearerPort, temp, { CONSOLE_MCP_AUTH_MODE: "bearer", CONSOLE_MCP_BEARER_TOKEN: "facade-bearer" });
  const crossConsumer = await mcp(bearerPort, `/mcp/${group}`, { method: "tools/list", id: 6 }, { authorization: "Bearer facade-bearer" });
  assert.equal(crossConsumer.status, 404);
  console.log(JSON.stringify({ ok: true, group, toolCount: tools.length, schemaFingerprint: fingerprint, oauth: true, unauthorized: true, crossConsumerDenied: true, legacyMcpPreserved: true }));
} finally {
  oauth?.kill("SIGTERM"); bearer?.kill("SIGTERM"); jwks.close();
  await rm(temp, { recursive: true, force: true });
}

async function freePort() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const port = 49152 + crypto.randomInt(16384);
    const server = http.createServer();
    try {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
      await new Promise((resolve) => server.close(resolve));
      return port;
    } catch (error) {
      server.close();
      if (error?.code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error("unable to reserve a high loopback port");
}
async function startRuntime(port, transcript, extra) {
  const child = spawn(process.execPath, ["dist/index.js"], { cwd: process.cwd(), env: { ...process.env, CONSOLE_MCP_MANAGED_RUNTIME: "smoke-test", CONSOLE_MCP_RELEASE_PROBE: "1", CONSOLE_MCP_HOST: "127.0.0.1", CONSOLE_MCP_PORT: String(port), CONSOLE_MCP_TRANSCRIPT_DIR: transcript, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
  const deadline = Date.now() + 15000; while (!output.includes("listening on")) { if (child.exitCode !== null) throw new Error(`runtime exited: ${output}`); if (Date.now() > deadline) throw new Error(`runtime start timeout: ${output}`); await new Promise((resolve) => setTimeout(resolve, 50)); }
  return child;
}
async function mcp(port, route, request, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", ...request }) });
  const text = await response.text(); const data = text.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? text;
  let body = {};
  if (data) { try { body = JSON.parse(data); } catch { body = { text: data }; } }
  return { status: response.status, headers: response.headers, body };
}
