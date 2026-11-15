import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { measureResponseBodyBytes } from "../dist/Infrastructure/Diagnostics/ResponseBodyMeasurement.js";

const root = process.cwd();
const temp = await mkdtemp(path.join(os.tmpdir(), "cmcp-http-trace-"));
const token = crypto.randomBytes(24).toString("hex");
const portServer = createServer();
await new Promise((resolve, reject) => {
  portServer.once("error", reject);
  portServer.listen(0, "127.0.0.1", resolve);
});
const port = portServer.address().port;
await new Promise(resolve => portServer.close(resolve));
const url = `http://127.0.0.1:${port}/mcp`;
const traceFile = path.join(temp, "trace", "mcp-request-trace.ndjson");
const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    CONSOLE_MCP_MANAGED_RUNTIME: "smoke-test",
    CONSOLE_MCP_AUTH_MODE: "bearer",
    CONSOLE_MCP_BEARER_TOKEN: token,
    CONSOLE_MCP_HOST: "127.0.0.1",
    CONSOLE_MCP_PORT: String(port),
    CONSOLE_MCP_TRACE: "1",
    CONSOLE_MCP_RESPONSE_BYTES_TRACE: "1",
    CONSOLE_MCP_WORKSPACE_ROOT: temp,
    CONSOLE_MCP_TRANSCRIPT_DIR: path.join(temp, "trace")
  }
});
let log = "";
for (const s of [child.stdout, child.stderr]) {
  s.on("data", chunk => { log = (log + String(chunk)).slice(-8000); });
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(test, label, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`child exited ${child.exitCode}: ${log}`);
    const v = await test();
    if (v) return v;
    await sleep(80);
  }
  throw new Error(`timeout waiting for ${label}: ${log}`);
}
async function records() {
  try { return (await readFile(traceFile, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
let client;
let transport;
try {
  await waitFor(async () => log.includes(`listening on ${url}`), "isolated MCP listener", 25000);
  const unauth = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9100, method: "tools/list", params: {} })
  });
  assert.equal(unauth.status, 401);
  const deniedText = await unauth.text();
  assert.equal(deniedText, "Unauthorized.");

  transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  });
  client = new Client({ name: "cmcp-http-integration", version: "1.0.0" });
  await client.connect(transport);
  const listed = await client.listTools();
  assert.ok(listed.tools.length > 0, "MCP tools/list must produce tools");
  const observed = await waitFor(async () => {
    const all = await records();
    const denied = all.find(x => x.http_status === 401 && x.http_method === "POST");
    const good = all.find(x => x.jsonrpc_method === "tools/list" && x.http_status === 200 && x.response_finish_fired);
    return denied && good ? { denied, good } : null;
  }, "request trace with body bytes");
  assert.equal(observed.denied.response_body_attempted_bytes, Buffer.byteLength(deniedText));
  assert.equal(observed.denied.response_aborted, false);
  assert.ok(observed.good.response_body_attempted_bytes > 0);
  assert.equal(observed.good.response_aborted, false);
  assert.equal(observed.good.response_finish_fired, true);
  console.log("PASS isolated MCP POST request trace (401 + authenticated tools/list + body bytes)");

  // Separate deterministic real HTTP socket-abort path: exact measurement
  // semantics are validated without risking a production MCP client or session.
  let aborted;
  const abortedDone = new Promise(resolve => { aborted = resolve; });
  const abortServer = createServer((_req, res) => {
    const measurement = measureResponseBodyBytes(res);
    const timer = setInterval(() => res.write(Buffer.alloc(512)), 30);
    res.once("close", () => {
      clearInterval(timer);
      aborted({ bytes: measurement.attemptedBytes, finish: res.writableFinished });
    });
  });
  try {
    await new Promise(resolve => abortServer.listen(0, "127.0.0.1", resolve));
    const response = await fetch(`http://127.0.0.1:${abortServer.address().port}/`, {
      signal: AbortSignal.timeout(3000)
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const firstChunk = await reader.read();
    assert.ok(firstChunk.value.byteLength > 0);
    await reader.cancel();
    const state = await Promise.race([abortedDone, sleep(3000).then(() => { throw new Error("abort close timeout"); })]);
    assert.equal(state.finish, false);
    assert.ok(state.bytes >= 512);
    console.log("PASS real HTTP streaming abort attempted-byte semantics");
  } finally {
    await new Promise(resolve => abortServer.close(resolve));
  }
} finally {
  await client?.close().catch(() => {});
  await transport?.close().catch(() => {});
  if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.race([once(child, "exit").catch(() => {}), sleep(2500)]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await rm(temp, { recursive: true, force: true });
}
