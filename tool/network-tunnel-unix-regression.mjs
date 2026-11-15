import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, chmod, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function port() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(49152 + crypto.randomInt(16383), "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

function post(socketPath, route, method, id) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath, path: route, method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => raw += chunk);
      res.on("end", () => {
        const data = raw.startsWith("event: ") ? (raw.match(/^data: (.*)$/m)?.[1] ?? "") : raw;
        let body = null;
        try { body = data ? JSON.parse(data) : null; } catch { /* expected text/plain 404 */ }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", id, method,
      ...(method === "initialize" ? { params: { protocolVersion: "2024-11-05",
        capabilities: {}, clientInfo: { name: "netmcp-unix-qa", version: "1" } } } : {}) }));
  });
}

const dir = await mkdtemp(path.join(tmpdir(), "netmcp-unix-"));
const privateDir = path.join(dir, "socketdir");
await mkdir(privateDir, { mode: 0o710 });
await chmod(privateDir, 0o710);
const socketPath = path.join(privateDir, "network.sock");
const observed = await lstat(privateDir);
const listenPort = await port();
let output = "";
const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env,
    CONSOLE_MCP_MANAGED_RUNTIME: "smoke-test", CONSOLE_MCP_RELEASE_PROBE: "1",
    CONSOLE_MCP_HOST: "127.0.0.1", CONSOLE_MCP_PORT: String(listenPort),
    CONSOLE_MCP_AUTH_MODE: "oauth",
    CONSOLE_MCP_PUBLIC_ORIGIN: "http://127.0.0.1:" + listenPort,
    CONSOLE_MCP_OAUTH_ISSUER: "http://127.0.0.1:" + listenPort,
    CONSOLE_MCP_OAUTH_AUDIENCE: "http://127.0.0.1:" + listenPort,
    CONSOLE_MCP_OAUTH_JWKS_URI: "http://127.0.0.1:" + listenPort + "/jwks",
    CONSOLE_MCP_NETWORK_FACADE_ENABLED: "1",
    CONSOLE_MCP_NETWORK_TUNNEL_SOCKET: socketPath,
    CONSOLE_MCP_NETWORK_TUNNEL_GID: String(observed.gid),
    CONSOLE_MCP_TRANSCRIPT_DIR: dir,
  },
});
child.stdout.on("data", (data) => output += data);
child.stderr.on("data", (data) => output += data);

try {
  const deadline = Date.now() + 20000;
  while (!output.includes("network-tunnel listening on protected Unix socket")) {
    if (child.exitCode !== null) throw Error("runtime exited: " + output.slice(-1600));
    if (Date.now() > deadline) throw Error("startup timeout: " + output.slice(-1600));
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  const sock = await lstat(socketPath);
  const parent = await lstat(privateDir);
  assert.ok(sock.isSocket());
  assert.equal(sock.mode & 0o777, 0o660);
  assert.equal(sock.gid, observed.gid);
  assert.equal(parent.mode & 0o777, 0o710);
  const mainOnSocket = await post(socketPath, "/mcp", "tools/list", 1);
  assert.equal(mainOnSocket.status, 404);
  const metadataOnSocket = await post(socketPath, "/.well-known/oauth-protected-resource", "tools/list", 2);
  assert.equal(metadataOnSocket.status, 404);
  const initialized = await post(socketPath, "/mcp/network", "initialize", 3);
  assert.equal(initialized.status, 200);
  const tools = await post(socketPath, "/mcp/network", "tools/list", 4);
  assert.equal(tools.status, 200);
  assert.deepEqual(tools.body.result.tools.map((t) => t.name).sort(), ["read_.network.http.probe", "read_.network.host.interfaces", "read_.network.serial.inventory", "read_.network.host.routes", "read_.network.host.neighbors"].sort());
  assert.ok(tools.body.result.tools.every((tool) => tool._meta?.securitySchemes === undefined && !tool.name.startsWith("write.")), "All Unix Network tools must be read-only without second OAuth");
  const unauthenticatedTcp = await fetch("http://127.0.0.1:" + listenPort + "/mcp/network", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list" }),
  });
  assert.equal(unauthenticatedTcp.status, 401);
  console.log("NETMCP_UNIX_TUNNEL_PASS ACL 0710/0660, five read-only tools, no OAuth on socket, TCP OAuth preserved, other paths 404");
} catch (error) {
  console.error("NETMCP_UNIX_TEST_ERROR", error);
  console.error("RUNTIME_LOG_TAIL", output.slice(-1200));
  process.exitCode = 1;
} finally {
  if (child.exitCode === null) {
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.kill("SIGTERM");
    await closed;
  }
  await rm(dir, { recursive: true, force: true });
}
