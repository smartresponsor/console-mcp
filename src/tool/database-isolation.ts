import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import net from "node:net";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildConsoleToolRegistration, buildConsoleMutationToolRegistration, textResult } from "./common.js";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";

const exec = promisify(execFile);
const HOST = "127.0.0.1";
const PORT = 5433;
const NAME = /^cmcp_test_[a-z0-9_]{3,48}$/;
const registryPath = path.resolve(process.cwd(), "var", "run", "database-isolation", "owned.json");
type Entry = { name: string; host: string; port: number; serverId: string; createdAt: string; preparedAt?: string };
type Registry = { entries: Entry[] };

function connection(): URL {
  const raw = process.env.CONSOLE_MCP_TEST_POSTGRES_URL;
  if (!raw) throw new Error("CONSOLE_MCP_TEST_POSTGRES_URL is required; the application DATABASE_URL is never used");
  const url = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== HOST || Number(url.port || 5432) !== PORT)
    throw new Error("Isolated database endpoint must be 127.0.0.1:5433 (never the application instance)");
  if (!url.username || !url.password) throw new Error("Dedicated test database credentials are required");
  return url;
}
function databaseUrl(url: URL, db: string): string { const result = new URL(url); result.pathname = "/" + db; return result.toString(); }
async function query(url: URL, db: string, sql: string): Promise<string> {
  const env = { ...process.env, PGPASSWORD: decodeURIComponent(url.password), PGCONNECT_TIMEOUT: "4" };
  const { stdout } = await exec("psql", ["-X", "-w", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", HOST, "-p", String(PORT), "-U", decodeURIComponent(url.username), "-d", db, "-c", sql], { env, timeout: 12000, windowsHide: true, maxBuffer: 65536 });
  return stdout.trim();
}
async function serverIdentity(url: URL): Promise<string> {
  const result = await query(url, url.pathname.slice(1) || "postgres", "SELECT system_identifier FROM pg_control_system()");
  if (!/^\d{10,}$/.test(result)) throw new Error("Cannot verify PostgreSQL instance identity; pg_monitor permission may be required");
  return result;
}
async function load(): Promise<Registry> {
  try { const data = JSON.parse(await fs.readFile(registryPath, "utf8")) as Registry; if (!Array.isArray(data.entries)) throw new Error("Invalid ownership registry"); return data; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [] }; throw error; }
}
async function save(registry: Registry): Promise<void> {
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  const temp = registryPath + "." + process.pid + ".tmp";
  try { await fs.writeFile(temp, JSON.stringify(registry, null, 2), { flag: "wx", mode: 0o600 }); await fs.rename(temp, registryPath); }
  finally { await fs.rm(temp, { force: true }); }
}
async function listener(): Promise<boolean> {
  return await new Promise((resolve) => {
    const s = net.connect({ host: HOST, port: PORT });
    s.setTimeout(1200);
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("timeout", () => { s.destroy(); resolve(false); });
    s.once("error", () => { s.destroy(); resolve(false); });
  });
}
async function inspect(name?: string): Promise<Record<string, unknown>> {
  const listening = await listener();
  const result: Record<string, unknown> = { ok: true, platform: process.platform, host: HOST, port: PORT, listening, registry: registryPath };
  try {
    const { stdout } = await exec(process.platform === "win32" ? "where.exe" : "which", ["psql"], { timeout: 3000, windowsHide: true });
    result.psql = stdout.trim().split(/\r?\n/)[0];
  } catch { result.psql = null; }
  const registry = await load();
  result.owned = registry.entries.map((e) => ({ name: e.name, createdAt: e.createdAt, preparedAt: e.preparedAt }));
  if (name) result.database = registry.entries.find((e) => e.name === name) ?? null;
  if (listening) {
    try { const url = connection(); result.serverId = await serverIdentity(url); result.connected = true; }
    catch (error) { result.connected = false; result.connectionError = error instanceof Error ? error.message : String(error); }
  }
  return result;
}
async function lifecycle(action: "create" | "prepare" | "release", name: string): Promise<Record<string, unknown>> {
  if (!NAME.test(name) || name === "cmcp_test_app") throw new Error("Database name must be a unique cmcp_test_ identifier");
  const url = connection();
  const identity = await serverIdentity(url);
  const registry = await load();
  const index = registry.entries.findIndex((e) => e.name === name);
  const entry = registry.entries[index];
  if (action === "create") {
    if (entry) throw new Error("Database is already registered");
    if (await query(url, url.pathname.slice(1) || "postgres", "SELECT 1 FROM pg_database WHERE datname = '" + name + "'") === "1")
      throw new Error("Database exists without ownership registration; refusing adoption");
    await query(url, url.pathname.slice(1) || "postgres", 'CREATE DATABASE "' + name + '"');
    registry.entries.push({ name, host: HOST, port: PORT, serverId: identity, createdAt: new Date().toISOString() });
    await save(registry);
    return { ok: true, action, name, endpoint: HOST + ":" + PORT };
  }
  if (!entry || entry.serverId !== identity || entry.host !== HOST || entry.port !== PORT)
    throw new Error("Database ownership or PostgreSQL instance identity mismatch");
  if (action === "prepare") {
    await query(url, name, 'CREATE SCHEMA IF NOT EXISTS cmcp_test');
    entry.preparedAt = new Date().toISOString();
    await save(registry);
    return { ok: true, action, name, databaseUrl: databaseUrl(url, name).replace(/:\/\/[^@]+@/, "://[redacted]@"), migrationsRequired: true };
  }
  await query(url, url.pathname.slice(1) || "postgres", 'DROP DATABASE "' + name + '" WITH (FORCE)');
  registry.entries.splice(index, 1);
  await save(registry);
  return { ok: true, action, name };
}
export function registerIsolatedDatabaseTools(server: McpServer, _policy: ConsolePolicy, auth: ConsoleAuthConfig): void {
  const schema = z.object({ name: z.string().regex(NAME) }).strict();
  server.registerTool("read_.database.isolated.inspect", { description: "Inspect local isolated PostgreSQL on 5433 independently of the application instance.", inputSchema: z.object({ name: z.string().regex(NAME).optional() }).strict(), ...buildConsoleToolRegistration(auth) }, async ({ name }) => textResult(await inspect(name)));
  server.registerTool("write.database.isolated.create", { description: "Create an exclusively owned test database on local PostgreSQL port 5433.", inputSchema: schema, ...buildConsoleMutationToolRegistration(auth) }, async ({ name }) => textResult(await lifecycle("create", name)));
  server.registerTool("write.database.isolated.prepare", { description: "Prepare an exclusively owned test database on local PostgreSQL port 5433.", inputSchema: schema, ...buildConsoleMutationToolRegistration(auth) }, async ({ name }) => textResult(await lifecycle("prepare", name)));
  server.registerTool("write.database.isolated.release", { description: "Release an exclusively owned test database on local PostgreSQL port 5433.", inputSchema: schema, ...buildConsoleMutationToolRegistration(auth) }, async ({ name }) => textResult(await lifecycle("release", name)));
}

