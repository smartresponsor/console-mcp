import assert from "node:assert/strict";
import { registerIsolatedDatabaseTools } from "../dist/tool/database-isolation.js";
const handlers = new Map();
const server = { registerTool(name, config, handler) { handlers.set(name, handler); } };
registerIsolatedDatabaseTools(server, {}, {});
assert.deepEqual([...handlers.keys()].sort(), ["read_.database.inspect", "write.database.create", "write.database.prepare", "write.database.release"].sort());
const inspected = await handlers.get("read_.database.inspect")({});
assert.equal(inspected.content?.[0]?.type, "text");
const snapshot = JSON.parse(inspected.content[0].text);
if (process.platform === "linux") {
  assert.equal(snapshot.backend, "rootless_postgres");
  assert.equal(Array.isArray(snapshot.managed), true);
} else {
  assert.equal(snapshot.port, 5433);
  assert.equal(snapshot.host, "127.0.0.1");
}
for (const action of ["write.database.create", "write.database.prepare", "write.database.release"]) {
  await assert.rejects(() => handlers.get(action)({ name: "app" }), /TEST_DATABASE_NAME_INVALID/);
}
console.log(JSON.stringify({ ok: true, status: "DATABASE_ISOLATION_FAIL_CLOSED", backend: snapshot.backend ?? "guarded_external_postgres" }));
