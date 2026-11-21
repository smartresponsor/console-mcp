import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { REPO_FACADE_TOOL_NAMES } from "../dist/engine/repo-facade-tools.js";
import { RELEASE_TRANSACTION_FACADE_TOOL_NAMES } from "../dist/engine/release-transaction-facade-tools.js";
import { TRANSPORT_FACADE_TOOL_NAMES } from "../dist/engine/transport-facade-tools.js";

const cases = {
  repo: { count: 69, call: "read_.repo.git.worktree.list", args: { workspacePath: process.env.CONSOLE_MCP_TEST_REPO_WORKSPACE ?? process.cwd() } },
  runtime: { count: 15, call: "read_.runtime.environment.status", args: {} },
  browser: { count: 51, call: "read_.browser.edge.session.status", args: {} },
  network: { count: 7, call: "read_.network.http.probe", args: { url: "http://127.0.0.1", method: "HEAD" } },
  looping: { count: 26, call: "read_.engine.worker.status", args: {} },
};
const group = process.argv[2];
const expected = cases[group];
assert.ok(expected, `unknown facade regression group: ${group}`);
const admission = JSON.parse(await readFile(new URL("../policy/console-tool-admission.json", import.meta.url), "utf8"));
const expectedNames = admission.declarations
  .filter((entry) => entry.consumers.includes("chatgpt") && entry.lifecycle !== "retired" && new RegExp(`^(?:read_|write)\\.${group === "looping" ? "engine" : group}\\.`).test(entry.name))
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
const token = await new SignJWT({ scope: group === "network" ? "console:read" : "console:read console:write" })
  .setProtectedHeader({ alg: "RS256", kid: jwk.kid }).setIssuer(issuer).setAudience(audience)
  .setIssuedAt().setExpirationTime("5m").sign(privateKey);

let oauth;
let bearer;
let cutover;
let disabledNetwork;
try {
  oauth = await startRuntime(oauthPort, temp, {
    CONSOLE_MCP_AUTH_MODE: "oauth", CONSOLE_MCP_PUBLIC_ORIGIN: audience,
    CONSOLE_MCP_OAUTH_ISSUER: issuer, CONSOLE_MCP_OAUTH_AUDIENCE: audience,
    CONSOLE_MCP_OAUTH_JWKS_URI: `${issuer}jwks`, CONSOLE_MCP_OAUTH_REQUIRED_SCOPE: "console:read",
    ...(group === "network" ? { CONSOLE_MCP_NETWORK_FACADE_ENABLED: "1" } : {}),
    ...(group === "repo" ? { CONSOLE_MCP_REPO_FACADE_ENABLED: "1" } : {}),
    ...(group === "repo" ? { CONSOLE_MCP_TRANSPORT_FACADE_ENABLED: "1", CONSOLE_MCP_RELEASE_TRANSACTION_FACADE_ENABLED: "1" } : {}),
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
  if (group === "browser") assert.ok(tools.some((tool) => tool.name === "write.browser.tab.close"), "browser facade must expose canonical target-only close");
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })).sort((a, b) => a.name.localeCompare(b.name)))).digest("hex").slice(0, 16);
  assert.match(fingerprint, /^[0-9a-f]{16}$/);
  const called = await mcp(oauthPort, `/mcp/${group}`, { method: "tools/call", id: 4, params: { name: expected.call, arguments: expected.args } }, headers);
  assert.equal(called.status, 200); assert.ok(called.body.result && !called.body.error, JSON.stringify(called.body));
  const baseline = await mcp(oauthPort, "/mcp", { method: "tools/list", id: 5 }, headers);
  assert.equal(baseline.status, 200); assert.ok(baseline.body.result.tools.length > tools.length);
  // NET282 ownership is independent of the optional in-process Repo endpoint.
  // All eight tools remain admitted in canonical registry but never callable via main /mcp.
  const mainNames = new Set(baseline.body.result.tools.map((tool) => tool.name));
  for (const name of REPO_FACADE_TOOL_NAMES) {
    assert.equal(mainNames.has(name), false, "Repo tool leaked into primary tools/list: " + name);
    const denied = await mcp(oauthPort, "/mcp", {
      method: "tools/call", id: 100 + REPO_FACADE_TOOL_NAMES.indexOf(name),
      params: { name, arguments: {} },
    }, headers);
    assert.equal(denied.status, 200);
    assert.ok(denied.body.error || denied.body.result?.isError, "Repo tool executed on primary /mcp: " + name);
  }
  if (group === "repo") {
    const repoOwn = await mcp(oauthPort, "/repo/mcp", { method: "tools/list", id: 120 }, headers);
    assert.equal(repoOwn.status, 200, JSON.stringify(repoOwn.body));
    assert.deepEqual(repoOwn.body.result.tools.map((tool) => tool.name).sort(), [...REPO_FACADE_TOOL_NAMES].sort());
    const healthy = await mcp(oauthPort, "/repo/mcp", { method: "tools/call", id: 121,
      params: { name: "read_.repo.git.worktree.list", arguments: { workspacePath: process.cwd() } },
    }, headers);
    assert.equal(healthy.status, 200);
    assert.ok(healthy.body.result && !healthy.body.error, JSON.stringify(healthy.body));
  }
  // Connected Transaction and Transport facades must exclusively own their six
  // capabilities, even when their optional in-process routes are switched off.
  for (const name of [...RELEASE_TRANSACTION_FACADE_TOOL_NAMES, ...TRANSPORT_FACADE_TOOL_NAMES]) {
    assert.equal(mainNames.has(name), false, "Transaction/Transport tool leaked into main list: " + name);
    const rejected = await mcp(oauthPort, "/mcp", {
      method: "tools/call", id: 200 + [...RELEASE_TRANSACTION_FACADE_TOOL_NAMES, ...TRANSPORT_FACADE_TOOL_NAMES].indexOf(name),
      params: { name, arguments: {} },
    }, headers);
    assert.equal(rejected.status, 200);
    assert.ok(rejected.body.error || rejected.body.result?.isError, "Main Console executed delegated tool: " + name);
  }
  if (group === "repo") {
    for (const [route, expectedDelegated] of [
      ["/release/mcp", RELEASE_TRANSACTION_FACADE_TOOL_NAMES],
      ["/transport/mcp", TRANSPORT_FACADE_TOOL_NAMES],
    ]) {
      const delegated = await mcp(oauthPort, route, { method: "tools/list", id: 230 }, headers);
      assert.equal(delegated.status, 200, JSON.stringify(delegated.body));
      assert.deepEqual(delegated.body.result.tools.map((tool) => tool.name).sort(), [...expectedDelegated].sort());
    }
  }
  if (group === "looping") {
    assert.ok(expectedNames.every((name) => !baseline.body.result.tools.some((tool) => tool.name === name)), "Looping tool leaked into primary ChatGPT tools/list");
    const rejected = await mcp(oauthPort, "/mcp", { method: "tools/call", id: 6, params: { name: expected.call, arguments: expected.args } }, headers);
    assert.ok(rejected.body.error || rejected.body.result?.isError, "Primary ChatGPT tools/call must fail closed for Looping");
    assert.notEqual(called.body.result?.isError, true, "Looping read-only tools/call returned isError");
    assert.ok(tools.every((x) => !/^(?:read_|write)\.(?:browser|repo|runtime)\./.test(x.name)), "Looping duplicates foreign facade tool");
  }
  if (group === "network") {
    assert.ok(expectedNames.every((name) => !baseline.body.result.tools.some((tool) => tool.name === name)), "No Network tool may leak into main ChatGPT when legacy cutover is OFF");
    const cutoverPort = await freePort();
    const cutoverAudience = `http://127.0.0.1:${cutoverPort}`;
    const cutoverToken = await new SignJWT({ scope: "console:read" })
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid }).setIssuer(issuer).setAudience(cutoverAudience)
      .setIssuedAt().setExpirationTime("5m").sign(privateKey);
    cutover = await startRuntime(cutoverPort, temp, {
      CONSOLE_MCP_AUTH_MODE: "oauth", CONSOLE_MCP_PUBLIC_ORIGIN: cutoverAudience,
      CONSOLE_MCP_OAUTH_ISSUER: issuer, CONSOLE_MCP_OAUTH_AUDIENCE: cutoverAudience,
      CONSOLE_MCP_OAUTH_JWKS_URI: `${issuer}jwks`, CONSOLE_MCP_OAUTH_REQUIRED_SCOPE: "console:read",
      CONSOLE_MCP_NETWORK_FACADE_ENABLED: "1", CONSOLE_MCP_NETWORK_FACADE_CUTOVER: "1",
    });
    const cutoverHeaders = { authorization: `Bearer ${cutoverToken}` };
    const cutoverMain = await mcp(cutoverPort, "/mcp", { method: "tools/list", id: 10 }, cutoverHeaders);
    const cutoverNetwork = await mcp(cutoverPort, "/mcp/network", { method: "tools/list", id: 11 }, cutoverHeaders);
    assert.equal(cutoverMain.status, 200);
    assert.equal(cutoverNetwork.status, 200);
    assert.ok(expectedNames.every((name) => !cutoverMain.body.result.tools.some((tool) => tool.name === name)), "Main ChatGPT must not expose any Network tool");
    assert.deepEqual(cutoverNetwork.body.result.tools.map((tool) => tool.name).sort(), expectedNames, "cutover must preserve façade inventory");
    const host = await mcp(cutoverPort, "/mcp/network", { method: "tools/call", id: 13, params: { name: "read_.network.host.interfaces", arguments: {} } }, cutoverHeaders);
    const serial = await mcp(cutoverPort, "/mcp/network", { method: "tools/call", id: 14, params: { name: "read_.network.serial.inventory", arguments: {} } }, cutoverHeaders);
    assert.equal(host.status, 200); assert.equal(serial.status, 200);
    assert.equal(host.body.result?.isError, undefined, JSON.stringify(host.body));
    assert.equal(serial.body.result?.isError, undefined, JSON.stringify(serial.body));
    assert.ok(host.body.result?.structuredContent?.interfaces || host.body.result?.content, "host inventory must return data");
    assert.ok(serial.body.result?.structuredContent?.ports || serial.body.result?.content, "serial inventory must return data");
    const sshCapability = await mcp(cutoverPort, "/mcp/network", {
      method: "tools/call", id: 25, params: { name: "read_.network.ssh.capability", arguments: {} },
    }, cutoverHeaders);
    assert.equal(sshCapability.status, 200);
    assert.ok(sshCapability.body.result && !sshCapability.body.error);
    assert.equal(sshCapability.body.result.isError, undefined);
    // Deliberately invalid input must be rejected BEFORE a Python worker or
    // TCP transport can be invoked, even on a provisioned lab runner.
    const sshRejected = await mcp(cutoverPort, "/mcp/network", {
      method: "tools/call", id: 26,
      params: { name: "read_.network.ssh.inspect",
        arguments: { targetId: "../../unapproved", observation: "reload" } },
    }, cutoverHeaders);
    assert.equal(sshRejected.status, 200);
    assert.ok(sshRejected.body.error || sshRejected.body.result?.isError,
      "invalid SSH target/operation must not pass schema validation");
    for (const name of ["read_.network.host.routes", "read_.network.host.neighbors"]) {
      const passive = await mcp(cutoverPort, "/mcp/network", {
        method: "tools/call", id: 24, params: { name, arguments: {} },
      }, cutoverHeaders);
      assert.equal(passive.status, 200);
      assert.ok(passive.body.result && !passive.body.result.isError,
        "passive network tool execution failed: " + name + JSON.stringify(passive.body));
    }
    assert.equal(cutoverMain.body.result.tools.length, baseline.body.result.tools.length, "Network exclusion must be independent of legacy cutover flag");
    const deniedMain = await mcp(cutoverPort, "/mcp", { method: "tools/call", id: 12, params: { name: expected.call, arguments: expected.args } }, cutoverHeaders);
    assert.equal(deniedMain.status, 200);
    assert.ok(deniedMain.body.error || deniedMain.body.result?.isError, "hidden tool call must not execute on main endpoint");
    // A disabled Network façade must never cause its tools to reappear on /mcp.
    const disabledPort = await freePort();
    const disabledAudience = `http://127.0.0.1:${disabledPort}`;
    const disabledToken = await new SignJWT({ scope: "console:read" })
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid }).setIssuer(issuer).setAudience(disabledAudience)
      .setIssuedAt().setExpirationTime("5m").sign(privateKey);
    disabledNetwork = await startRuntime(disabledPort, temp, {
      CONSOLE_MCP_AUTH_MODE: "oauth", CONSOLE_MCP_PUBLIC_ORIGIN: disabledAudience,
      CONSOLE_MCP_OAUTH_ISSUER: issuer, CONSOLE_MCP_OAUTH_AUDIENCE: disabledAudience,
      CONSOLE_MCP_OAUTH_JWKS_URI: `${issuer}jwks`, CONSOLE_MCP_OAUTH_REQUIRED_SCOPE: "console:read",
      CONSOLE_MCP_NETWORK_FACADE_ENABLED: "0", CONSOLE_MCP_NETWORK_FACADE_CUTOVER: "0",
      CONSOLE_MCP_NETWORK_TUNNEL_SOCKET: "",
    });
    const disabledHeaders = { authorization: `Bearer ${disabledToken}` };
    const disabledMain = await mcp(disabledPort, "/mcp", { method: "tools/list", id: 15 }, disabledHeaders);
    assert.equal(disabledMain.status, 200);
    assert.ok(expectedNames.every((name) => !disabledMain.body.result.tools.some((tool) => tool.name === name)),
      "disabled Network facade leaked names into main ChatGPT");
    const disabledRoute = await mcp(disabledPort, "/mcp/network", { method: "tools/list", id: 16 }, disabledHeaders);
    assert.equal(disabledRoute.status, 404, "disabled Network facade must not serve its route");
    for (const name of expectedNames) {
      const args = name === expected.call ? expected.args : {};
      const mainCall = await mcp(cutoverPort, "/mcp", { method: "tools/call", id: 17, params: { name, arguments: args } }, cutoverHeaders);
      assert.equal(mainCall.status, 200);
      assert.ok(mainCall.body.error || mainCall.body.result?.isError, `main ChatGPT unexpectedly executed ${name}`);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  const auditFiles = await readdir(temp, { recursive: true });
  assert.ok(auditFiles.length > 0, "facade requests must retain canonical audit output");

  bearer = await startRuntime(bearerPort, temp, { CONSOLE_MCP_AUTH_MODE: "bearer", CONSOLE_MCP_BEARER_TOKEN: "facade-bearer" });
  const crossConsumer = await mcp(bearerPort, `/mcp/${group}`, { method: "tools/list", id: 6 }, { authorization: "Bearer facade-bearer" });
  assert.equal(crossConsumer.status, 404);
  console.log(JSON.stringify({ ok: true, group, toolCount: tools.length, schemaFingerprint: fingerprint, oauth: true, unauthorized: true, crossConsumerDenied: true, legacyMcpPreserved: true }));
} finally {
  oauth?.kill("SIGTERM"); bearer?.kill("SIGTERM"); cutover?.kill("SIGTERM"); disabledNetwork?.kill("SIGTERM"); jwks.close();
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
