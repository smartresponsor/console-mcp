import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, chmod, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OWNER_REPO_FACADE_TOOL_NAMES } from "../dist/engine/repo-facade-tools.js";

function post(socketPath, route, method = "tools/list", id = 1) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: route, method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" } }, (res) => {
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
        capabilities: {}, clientInfo: { name: "repo-unix-qa", version: "1" } } } : {}) }));
  });
}

const dir = await mkdtemp(path.join(tmpdir(), "repo-unix-"));
const privateDir = path.join(dir, "socketdir");
await mkdir(privateDir, { mode: 0o710 });
await chmod(privateDir, 0o710);
const socketPath = path.join(privateDir, "repo.sock");
const observed = await lstat(privateDir);
const listenPort = 54000 + Math.floor(Math.random() * 4000);
let output = "";
const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
    CONSOLE_MCP_REPO_OWNER_ROUTING: "1", CONSOLE_MCP_REPO_FACADE_ENABLED: "0", CONSOLE_MCP_WORKSPACE_ROOT: dir,
    CONSOLE_MCP_MANAGED_RUNTIME: "smoke-test", CONSOLE_MCP_RELEASE_PROBE: "1",
    CONSOLE_MCP_HOST: "127.0.0.1", CONSOLE_MCP_PORT: String(listenPort), CONSOLE_MCP_AUTH_MODE: "oauth",
    CONSOLE_MCP_PUBLIC_ORIGIN: `http://127.0.0.1:${listenPort}`,
    CONSOLE_MCP_OAUTH_ISSUER: "https://example.invalid/", CONSOLE_MCP_OAUTH_AUDIENCE: `http://127.0.0.1:${listenPort}`,
    CONSOLE_MCP_REPO_TUNNEL_SOCKET: socketPath, CONSOLE_MCP_REPO_TUNNEL_GID: String(observed.gid),
    CONSOLE_MCP_TRANSCRIPT_DIR: dir,
  },
});
child.stdout.on("data", (data) => output += data);
child.stderr.on("data", (data) => output += data);

try {
  const deadline = Date.now() + 20000;
  while (!output.includes("repo-tunnel listening on protected Unix socket")) {
    if (child.exitCode !== null) throw Error("runtime exited: " + output.slice(-1600));
    if (Date.now() > deadline) throw Error("startup timeout: " + output.slice(-1600));
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  const sock = await lstat(socketPath);
  assert.ok(sock.isSocket()); assert.equal(sock.mode & 0o777, 0o660); assert.equal(sock.gid, observed.gid);
  assert.equal((await lstat(privateDir)).mode & 0o777, 0o710);
  for (const route of ["/mcp", "/mcp/network", "/mcp/looping", "/.well-known/oauth-protected-resource"]) {
    assert.equal((await post(socketPath, route)).status, 404, route);
  }
  assert.equal((await post(socketPath, "/mcp/repo", "initialize", 2)).status, 200);
  const listed = await post(socketPath, "/mcp/repo", "tools/list", 3);
  assert.equal(listed.status, 200);
  const names = listed.body.result.tools.map((tool) => tool.name);
  assert.equal(names.length, 32, "owner routing must remove 37 owner Repo capabilities from existing 69");
  assert.equal(new Set(names).size, 32, "canonical Repo projection must not contain duplicates");
  assert.ok(names.every((name) => /^(?:read_|write)\.repo\./.test(name)), "Repo projection contains a foreign tool");
  for (const name of OWNER_REPO_FACADE_TOOL_NAMES) assert.ok(!names.includes(name), "owner capability leaked to socket: "+name);
  const tcp = await fetch(`http://127.0.0.1:${listenPort}/mcp/repo`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }) });
  assert.equal(tcp.status, 401);
  console.log("ENG16_M5_OWNER_EXCLUSION_TRUSTED_SOCKET_PASS");
} finally {
  if (child.exitCode === null) { const closed = new Promise((resolve) => child.once("close", resolve)); child.kill("SIGTERM"); await closed; }
  await rm(dir, { recursive: true, force: true });
}
