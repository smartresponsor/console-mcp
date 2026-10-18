import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { rootlessDatabaseAction, inspectRootlessDatabases } from "../dist/tool/database-rootless.js";
const name = "cmcp_test_" + randomBytes(6).toString("hex");
let created = false;
try {
  const before = await inspectRootlessDatabases();
  assert.equal(before.ok, true);
  const create = await rootlessDatabaseAction("create", name);
  assert.equal(create.ok, true);
  created = true;
  assert.equal(create.endpoint, "unix_socket");
  const inspect = await rootlessDatabaseAction("inspect", name);
  assert.equal(inspect.managed, true);
  assert.equal(inspect.online, true);
  assert.equal(inspect.expired, false);
  assert.ok(Date.parse(inspect.expiresAt) > Date.now());
  const dataDir = path.join(os.homedir(), "database-sandboxes", name, "data");
  execFileSync("/usr/lib/postgresql/16/bin/pg_ctl", ["-D", dataDir, "-m", "fast", "-w", "stop"]);
  const stopped = await rootlessDatabaseAction("inspect", name);
  assert.equal(stopped.online, false);
  const prepared = await rootlessDatabaseAction("prepare", name);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.schemaReady, true);
  const restarted = await rootlessDatabaseAction("inspect", name);
  assert.equal(restarted.online, true);
  const lease = await rootlessDatabaseAction("inspect", name);
  assert.equal(lease.expired, false);
  assert.ok(Date.parse(lease.expiresAt) > Date.now());
  const released = await rootlessDatabaseAction("release", name);
  assert.equal(released.released, true);
  created = false;
  const after = await inspectRootlessDatabases();
  assert.equal(after.managed.some(e => e.name === name), false);
  console.log(JSON.stringify({ ok: true, status: "DATABASE_ROOTLESS_LIFECYCLE_GREEN", name, socket_only: true, prepared: true, released: true }));
} finally {
  if (created) {
    try { await rootlessDatabaseAction("release", name); }
    catch (error) { console.error("Rootless sandbox cleanup requires inspection:", name, String(error)); }
  }
}
