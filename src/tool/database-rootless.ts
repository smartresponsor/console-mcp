import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const BIN = "/usr/lib/postgresql/16/bin";
const PG_PORT = "55432"; // Unix-socket filename only; TCP listen_addresses is empty.
const NAME = /^cmcp_test_[a-z0-9_]{3,48}$/;
const ROOT = path.join(os.homedir(), "database-sandboxes");
type Manifest = { schema: 1; name: string; uid: number; clusterId: string; createdAt: string; preparedAt?: string; expiresAt?: string };
type Paths = { root: string; base: string; data: string; socket: string; log: string; marker: string };
function locations(name: string): Paths {
  if (!NAME.test(name)) throw new Error("DATABASE_SANDBOX_INVALID_NAME");
  const base = path.join(ROOT, name);
  return { root: ROOT, base, data: path.join(base, "data"), socket: path.join(base, "socket"), log: path.join(base, "postgres.log"), marker: path.join(base, "owner.json") };
}
function uid(): number {
  if (typeof process.getuid !== "function" || process.platform !== "linux") throw new Error("DATABASE_SANDBOX_LINUX_ONLY");
  const current = process.getuid();
  if (current === 0) throw new Error("DATABASE_SANDBOX_ROOT_FORBIDDEN");
  return current;
}
async function run(bin: string, args: string[], timeout = 20000): Promise<string> {
  const { stdout } = await execute(path.join(BIN, bin), args, { timeout, windowsHide: true, maxBuffer: 32768, env: { ...process.env, PGCONNECT_TIMEOUT: "4", PGOPTIONS: "" } });
  return stdout.trim();
}
async function checkPrivateDirectory(p: string): Promise<void> {
  const stat = await fs.lstat(p);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid() || (stat.mode & 0o077) !== 0)
    throw new Error("DATABASE_SANDBOX_DIRECTORY_OWNERSHIP_REJECTED");
}
async function ensureRoot(): Promise<void> {
  await fs.mkdir(ROOT, { recursive: true, mode: 0o700 });
  await checkPrivateDirectory(ROOT);
}
async function manifest(loc: Paths): Promise<Manifest> {
  await checkPrivateDirectory(loc.base);
  await checkPrivateDirectory(loc.data);
  await checkPrivateDirectory(loc.socket);
  const stats = await fs.lstat(loc.marker);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== uid() || (stats.mode & 0o077) !== 0)
    throw new Error("DATABASE_SANDBOX_MARKER_REJECTED");
  const m = JSON.parse(await fs.readFile(loc.marker, "utf8")) as Manifest;
  if (m.schema !== 1 || m.name !== path.basename(loc.base) || m.uid !== uid() || !/^\d{10,}$/.test(m.clusterId) || (m.expiresAt !== undefined && !Number.isFinite(Date.parse(m.expiresAt))))
    throw new Error("DATABASE_SANDBOX_OWNERSHIP_REJECTED");
  return m;
}
async function save(loc: Paths, m: Manifest): Promise<void> {
  const next = loc.marker + "." + process.pid + ".tmp";
  try { await fs.writeFile(next, JSON.stringify(m, null, 2) + "\n", { mode: 0o600, flag: "wx" }); await fs.rename(next, loc.marker); }
  finally { await fs.rm(next, { force: true }); }
}
async function withLock<T>(loc: Paths, fn: () => Promise<T>): Promise<T> {
  await ensureRoot();
  const lockPath = path.join(ROOT, loc.base.split(path.sep).at(-1) + ".lock");
  let lock;
  try { lock = await fs.open(lockPath, "wx", 0o600); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error("DATABASE_SANDBOX_OPERATION_BUSY"); throw err; }
  try { return await fn(); }
  finally { await lock.close(); await fs.rm(lockPath, { force: true }); }
}
function psqlArgs(loc: Paths, database: string, sql: string): string[] {
  return ["-X", "-w", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", loc.socket, "-p", PG_PORT, "-U", os.userInfo().username, "-d", database, "-c", sql];
}
async function online(loc: Paths): Promise<boolean> {
  try { await run("pg_ctl", ["-D", loc.data, "status"], 4000); return true; }
  catch { return false; }
}
async function start(loc: Paths): Promise<void> {
  if (await online(loc)) return;
  await run("pg_ctl", ["-D", loc.data, "-l", loc.log, "-o", "-c listen_addresses= -c unix_socket_directories=" + loc.socket + " -c port=" + PG_PORT + " -c max_connections=15", "-w", "start"], 20000);
}
async function verify(loc: Paths, m: Manifest): Promise<void> {
  await start(loc);
  const current = await run("psql", psqlArgs(loc, "postgres", "SELECT system_identifier FROM pg_control_system()"));
  if (current !== m.clusterId) throw new Error("DATABASE_SANDBOX_CLUSTER_ID_MISMATCH");
}
export async function rootlessDatabaseAction(action: "create" | "prepare" | "release" | "inspect", name: string): Promise<Record<string, unknown>> {
  const loc = locations(name);
  return await withLock(loc, async () => {
    if (action === "create") {
      if (await fs.lstat(loc.base).then(() => true).catch(e => { if (e.code === "ENOENT") return false; throw e; }))
        throw new Error("DATABASE_SANDBOX_ALREADY_EXISTS_NO_ADOPTION");
      await fs.mkdir(loc.base, { mode: 0o700 });
      await fs.mkdir(loc.socket, { mode: 0o700 });
      await run("initdb", ["-D", loc.data, "-A", "trust", "--encoding=UTF8", "--locale=C", "--no-instructions"], 30000);
      await start(loc);
      const clusterId = await run("psql", psqlArgs(loc, "postgres", "SELECT system_identifier FROM pg_control_system()"));
      if (!/^\d{10,}$/.test(clusterId)) throw new Error("DATABASE_SANDBOX_CLUSTER_ID_UNAVAILABLE");
      const now = Date.now();
      const m: Manifest = { schema: 1, name, uid: uid(), clusterId, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString() };
      await save(loc, m);
      await run("createdb", ["-h", loc.socket, "-p", PG_PORT, "-U", os.userInfo().username, name]);
      return { ok: true, action, name, endpoint: "unix_socket", socketDirectory: loc.socket, socketPort: Number(PG_PORT), clusterId };
    }
    const m = await manifest(loc);
    if (action === "inspect") return { ok: true, action, name, managed: true, online: await online(loc), createdAt: m.createdAt, preparedAt: m.preparedAt ?? null, expiresAt: m.expiresAt ?? null, expired: m.expiresAt !== undefined && Date.now() >= Date.parse(m.expiresAt), socketDirectory: loc.socket, socketPort: Number(PG_PORT) };
    if (action === "prepare" && m.expiresAt !== undefined && Date.now() >= Date.parse(m.expiresAt)) throw new Error("DATABASE_SANDBOX_LEASE_EXPIRED");
    await verify(loc, m);
    if (action === "prepare") {
      await run("psql", psqlArgs(loc, name, "CREATE SCHEMA IF NOT EXISTS cmcp_test"));
      m.preparedAt = new Date().toISOString();
      await save(loc, m);
      return { ok: true, action, name, schemaReady: true, migrationsApplied: false, socketDirectory: loc.socket, socketPort: Number(PG_PORT) };
    }
    await run("pg_ctl", ["-D", loc.data, "-m", "fast", "-w", "stop"], 15000);
    await checkPrivateDirectory(loc.base);
    await checkPrivateDirectory(loc.data);
    await checkPrivateDirectory(loc.socket);
    await manifest(loc);
    await fs.rm(loc.base, { recursive: true, force: false });
    return { ok: true, action, name, released: true };
  });
}
export async function inspectRootlessDatabases(): Promise<Record<string, unknown>> {
  await ensureRoot();
  const entries = await fs.readdir(ROOT, { withFileTypes: true });
  const managed: Record<string, unknown>[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !NAME.test(entry.name)) continue;
    try {
      const loc = locations(entry.name);
      const m = await manifest(loc);
      managed.push({ name: m.name, createdAt: m.createdAt, preparedAt: m.preparedAt ?? null, expiresAt: m.expiresAt ?? null, expired: m.expiresAt !== undefined && Date.now() >= Date.parse(m.expiresAt), online: await online(loc) });
    } catch { managed.push({ name: entry.name, status: "unverified_not_managed" }); }
  }
  return { ok: true, backend: "rootless_postgres", platform: process.platform, managed, root: ROOT };
}
