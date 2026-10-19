import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { buildConsoleToolRegistration, buildConsoleMutationToolRegistration, textResult } from "./common.js";
import { rootlessDatabaseAction, inspectRootlessDatabases } from "./database-rootless.js";

const exec = promisify(execFile);
const HOST = "127.0.0.1", PORT = 5433;
const TEST_NAME = /^cmcp_test_[a-z0-9_]{3,48}$/;
const stateRoot = path.resolve(process.cwd(), "var/run/database-isolation");
type Owned = { name: string; clusterId: string; createdAt: string; preparedAt?: string };
type Registry = { entries: Owned[] };
async function tcpOpen(): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: HOST, port: PORT });
    socket.setTimeout(900);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}
function testConnection(): URL {
  const raw = process.env.CONSOLE_MCP_TEST_POSTGRES_URL;
  if (!raw) throw new Error("TEST_POSTGRES_NOT_CONFIGURED: set CONSOLE_MCP_TEST_POSTGRES_URL for the isolated instance; never use DATABASE_URL");
  const url = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== HOST || Number(url.port || 5432) !== PORT || !url.username || !url.password || url.pathname !== "/postgres")
    throw new Error("TEST_POSTGRES_ENDPOINT_REJECTED: dedicated credentials and 127.0.0.1:5433 are required");
  return url;
}
function adminDb(url: URL): string { return url.pathname.slice(1) || "postgres"; }
async function sql(url: URL, db: string, statement: string): Promise<string> {
  const env = { ...process.env, PGPASSWORD: decodeURIComponent(url.password), PGCONNECT_TIMEOUT: "3" };
  const { stdout } = await exec("psql", ["-X", "-w", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", HOST, "-p", String(PORT), "-U", decodeURIComponent(url.username), "-d", db, "-c", statement], { env, timeout: 12000, windowsHide: true, maxBuffer: 131072 });
  return stdout.trim();
}
async function clusterId(url: URL): Promise<string> {
  const identity = await sql(url, adminDb(url), "SELECT system_identifier FROM pg_control_system()");
  if (!/^\d{10,}$/.test(identity)) throw new Error("TEST_CLUSTER_IDENTITY_UNVERIFIED: pg_control_system() access required");
  return identity;
}
async function loadRegistry(): Promise<Registry> {
  try { const parsed = JSON.parse(await fs.readFile(path.join(stateRoot, "owned.json"), "utf8")) as Registry; if (!Array.isArray(parsed.entries)) throw new Error("Invalid registry"); return parsed; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [] }; throw error; }
}
async function saveRegistry(state: Registry): Promise<void> {
  await fs.mkdir(stateRoot, { recursive: true });
  const destination = path.join(stateRoot, "owned.json");
  const temporary = destination + "." + process.pid + ".tmp";
  try { await fs.writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600, flag: "wx" }); await fs.rename(temporary, destination); }
  finally { await fs.rm(temporary, { force: true }); }
}
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(stateRoot, { recursive: true });
  const name = path.join(stateRoot, "operation.lock");
  const handle = await fs.open(name, "wx").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "EEXIST") throw new Error("TEST_DATABASE_OPERATION_BUSY");
    throw e;
  });
  try { return await fn(); }
  finally { await handle.close(); await fs.rm(name, { force: true }); }
}
async function inspect(name?: string): Promise<Record<string, unknown>> {
  if (process.platform === "linux") return name ? await rootlessDatabaseAction("inspect", name) : await inspectRootlessDatabases();
  const listening = await tcpOpen();
  const registry = await loadRegistry();
  const result: Record<string, unknown> = { ok: true, platform: process.platform, host: HOST, port: PORT, listening, registered: registry.entries.map(e => ({ name: e.name, createdAt: e.createdAt, preparedAt: e.preparedAt ?? null })) };
  try { const { stdout } = await exec(process.platform === "win32" ? "where.exe" : "which", ["psql"], { timeout: 2500 }); result.psqlExecutable = stdout.trim().split(/\r?\n/)[0] || null; }
  catch { result.psqlExecutable = null; }
  if (name) result.owned = registry.entries.some(e => e.name === name);
  if (listening) try { const url = testConnection(); result.clusterId = await clusterId(url); result.authenticated = true; }
  catch (error) { result.authenticated = false; result.diagnostic = String(error instanceof Error ? error.message : error); }
  return result;
}
async function mutate(action: "create" | "prepare" | "release", name: string): Promise<Record<string, unknown>> {
  if (!TEST_NAME.test(name) || name === "cmcp_test_app") throw new Error("TEST_DATABASE_NAME_INVALID");
  if (process.platform === "linux") return await rootlessDatabaseAction(action, name);
  return await withLock(async () => {
    const url = testConnection();
    const identity = await clusterId(url);
    const approvedCluster = process.env.CONSOLE_MCP_TEST_POSTGRES_SYSTEM_ID;
    if (!approvedCluster || approvedCluster !== identity) throw new Error("TEST_CLUSTER_NOT_APPROVED: pin CONSOLE_MCP_TEST_POSTGRES_SYSTEM_ID to the inspected cluster identity before write operations");
    const registry = await loadRegistry();
    const index = registry.entries.findIndex(item => item.name === name);
    const owned = registry.entries[index];
    if (action === "create") {
      if (index >= 0) throw new Error("TEST_DATABASE_ALREADY_MANAGED");
      const exists = await sql(url, adminDb(url), "SELECT count(*) FROM pg_database WHERE datname = '" + name + "'");
      if (exists !== "0") throw new Error("TEST_DATABASE_ALREADY_EXISTS_UNOWNED");
      await sql(url, adminDb(url), 'CREATE DATABASE "' + name + '"');
      registry.entries.push({ name, clusterId: identity, createdAt: new Date().toISOString() });
      await saveRegistry(registry);
      return { ok: true, action, name, host: HOST, port: PORT };
    }
    if (!owned || owned.clusterId !== identity) throw new Error("TEST_DATABASE_OWNERSHIP_NOT_VERIFIED");
    const exists = await sql(url, adminDb(url), "SELECT count(*) FROM pg_database WHERE datname = '" + name + "'");
    if (exists !== "1") throw new Error("TEST_DATABASE_MISSING_ON_CLUSTER");
    if (action === "prepare") {
      await sql(url, name, "CREATE SCHEMA IF NOT EXISTS cmcp_test");
      owned.preparedAt = new Date().toISOString();
      await saveRegistry(registry);
      return { ok: true, action, name, schemaReady: true, migrationsApplied: false, nextAction: "Run Symfony migrations with a process-scoped DATABASE_URL pointing to the owned test database" };
    }
    await sql(url, adminDb(url), 'DROP DATABASE "' + name + '" WITH (FORCE)');
    registry.entries.splice(index, 1);
    await saveRegistry(registry);
    return { ok: true, action, name };
  });
}
export function registerIsolatedDatabaseTools(server: McpServer, _policy: ConsolePolicy, auth: ConsoleAuthConfig): void {
  const input = z.object({ name: z.string().regex(TEST_NAME) }).strict();
  server.registerTool("read_.database.inspect", { description: "Inspect owned rootless PostgreSQL sandboxes on Linux or guarded local PostgreSQL on Windows; never inspect application data.", inputSchema: z.object({ name: z.string().regex(TEST_NAME).optional() }).strict(), ...buildConsoleToolRegistration(auth) }, async ({name}) => textResult(await inspect(name)));
  server.registerTool("write.database.create", { description: "Create an owned isolated PostgreSQL test instance on Linux private Unix socket; Windows uses separately approved test instance.", inputSchema: input, ...buildConsoleMutationToolRegistration(auth) }, async ({name}) => textResult(await mutate("create", name)));
  server.registerTool("write.database.prepare", { description: "Prepare schema on an owned isolated PostgreSQL test database; Symfony migrations are not automatically executed.", inputSchema: input, ...buildConsoleMutationToolRegistration(auth) }, async ({name}) => textResult(await mutate("prepare", name)));
  server.registerTool("write.database.release", { description: "Release an owned PostgreSQL test instance only after validating owner manifest, UID, and cluster identity.", inputSchema: input, ...buildConsoleMutationToolRegistration(auth) }, async ({name}) => textResult(await mutate("release", name)));
  // Keep the established master API backed by the same ownership and approval guards.
  server.registerTool("read_.database.isolated.inspect", { description: "Inspect owned rootless PostgreSQL sandboxes on Linux or guarded local PostgreSQL on Windows; never inspect application data.", inputSchema: z.object({ name: z.string().regex(TEST_NAME).optional() }).strict(), ...buildConsoleToolRegistration(auth) }, async ({name}) => textResult(await inspect(name)));
  server.registerTool("write.database.isolated.create", { description: "Create an owned isolated PostgreSQL test instance on Linux private Unix socket; Windows uses separately approved test instance.", inputSchema: input, ...buildConsoleMutationToolRegistration(auth) }, async ({name}) => textResult(await mutate("create", name)));
  server.registerTool("write.database.isolated.prepare", { description: "Prepare schema on an owned isolated PostgreSQL test database; Symfony migrations are not automatically executed.", inputSchema: input, ...buildConsoleMutationToolRegistration(auth) }, async ({name}) => textResult(await mutate("prepare", name)));
  server.registerTool("write.database.isolated.release", { description: "Release an owned PostgreSQL test instance only after validating owner manifest, UID, and cluster identity.", inputSchema: input, ...buildConsoleMutationToolRegistration(auth) }, async ({name}) => textResult(await mutate("release", name)));
}
