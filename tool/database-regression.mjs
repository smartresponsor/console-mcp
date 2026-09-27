import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import initSqlJs from "sql.js";
import {
  databaseToolTestApi,
  resolveSQLiteConnection,
  runSQLiteDiagnosticsTool,
  runSQLiteQueryTool,
  validateReadOnlyCommandQuery,
  validateReadOnlySQLiteQuery,
} from "../dist/tool/database.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-mcp-db-"));
const workspace = path.join(tmp, "workspace");
fs.mkdirSync(path.join(workspace, "config", "packages"), { recursive: true });
fs.mkdirSync(path.join(workspace, "var"), { recursive: true });

const policy = {
  serverName: "test",
  version: "test",
  transport: "streamable-http",
  endpoint: "/mcp",
  host: "127.0.0.1",
  port: 3333,
  workspaceRoot: tmp,
  allowedRoots: [tmp],
  deniedPath: { denyBasenames: [], denyExtensions: [], denyPathFragments: [], allowlist: [] },
  allowedChecks: { defaultTimeoutMs: 1000, checks: {} },
  maxFileBytes: 262144,
  maxSearchResults: 50,
  maxStatusLines: 200,
  transcriptDir: path.join(tmp, "transcript"),
  loaded: true,
};

const SQL = await initSqlJs();

function writeFixture(filePath) {
  const db = new SQL.Database();
  db.run("create table parent (id integer primary key, name text not null)");
  db.run("create table child (id integer primary key, parent_id integer not null, payload blob, foreign key(parent_id) references parent(id))");
  db.run("create index child_parent_idx on child(parent_id)");
  db.run("insert into parent (id, name) values (1, 'alpha'), (2, 'beta'), (3, 'gamma')");
  db.run("insert into child (id, parent_id, payload) values (1, 1, X'010203')");
  fs.writeFileSync(filePath, Buffer.from(db.export()));
  db.close();
}

function mustReject(fn, pattern, label) {
  assert.throws(fn, pattern, label);
}

const sqlitePath = path.join(workspace, "var", "platform_system.sqlite");
writeFixture(sqlitePath);
fs.writeFileSync(path.join(workspace, "config", "packages", "doctrine.yaml"), `
doctrine:
    dbal:
        default_connection: postgres
        connections:
            postgres:
                url: '%env(DATABASE_URL)%'
                driver: 'pdo_pgsql'
            sqlite:
                driver: 'pdo_sqlite'
                path: '%kernel.project_dir%/var/platform_system.sqlite'
    orm:
        entity_managers:
            system:
                connection: sqlite
`);

fs.writeFileSync(path.join(workspace, ".env"), "DATABASE_URL=postgresql://db_user:super-secret-password@example.invalid/app\n");

assert.equal(validateReadOnlyCommandQuery("select 1", "postgres"), "select 1");
assert.equal(validateReadOnlyCommandQuery("with x as (select 1) select * from x", "postgres"), "with x as (select 1) select * from x");
assert.equal(validateReadOnlyCommandQuery("show server_version", "postgres"), "show server_version");
assert.equal(validateReadOnlyCommandQuery("explain select 1", "postgres"), "explain select 1");
mustReject(() => validateReadOnlyCommandQuery("insert into t values (1)", "postgres"), /Only SELECT|Blocked SQL/, "postgres rejects insert");
mustReject(() => validateReadOnlyCommandQuery("select 1; select 2", "postgres"), /Exactly one SQL statement/, "postgres rejects multi-statement");
mustReject(() => validateReadOnlyCommandQuery("show all", "postgres"), /SHOW ALL/, "postgres rejects show all");

assert.equal(validateReadOnlySQLiteQuery("select * from sqlite_schema"), "select * from sqlite_schema");
assert.equal(validateReadOnlySQLiteQuery("pragma table_list"), "pragma table_list");
assert.equal(validateReadOnlySQLiteQuery("pragma table_info(parent)"), "pragma table_info(parent)");
assert.equal(validateReadOnlySQLiteQuery("explain query plan select * from parent"), "explain query plan select * from parent");
for (const sql of [
  "pragma journal_mode=WAL",
  "insert into parent values (4, 'x')",
  "update parent set name = 'x'",
  "delete from parent",
  "create table nope (id integer)",
  "drop table parent",
  "attach database 'x' as x",
  "select 1; select 2",
]) {
  mustReject(() => validateReadOnlySQLiteQuery(sql), /Only|Blocked|Exactly/, `sqlite rejects ${sql}`);
}

const doctrineConnections = databaseToolTestApi.parseDoctrineConnectionPaths(fs.readFileSync(path.join(workspace, "config", "packages", "doctrine.yaml"), "utf8"));
const doctrineManagers = databaseToolTestApi.parseDoctrineEntityManagers(fs.readFileSync(path.join(workspace, "config", "packages", "doctrine.yaml"), "utf8"));
assert.equal(doctrineConnections.get("sqlite"), "%kernel.project_dir%/var/platform_system.sqlite");
assert.equal(doctrineManagers.get("system"), "sqlite");

let connection = resolveSQLiteConnection(policy, workspace, "system");
assert.equal(connection.source.kind, "workspace_doctrine");
assert.equal(connection.source.entityManager, "system");
assert.equal(connection.source.connection, "sqlite");
assert.equal(connection.path, sqlitePath);

process.env.CONSOLE_MCP_SQLITE_REPORT_URL = `sqlite:///${sqlitePath.replaceAll("\\", "/")}`;
connection = resolveSQLiteConnection(policy, undefined, "report");
assert.equal(connection.source.kind, "process_env");
delete process.env.CONSOLE_MCP_SQLITE_REPORT_URL;

let queryResult = await runSQLiteQueryTool(policy, { workspacePath: workspace, alias: "system", query: "select id, name from parent order by id", limit: 2 });
assert.equal(queryResult.ok, true);
assert.equal(queryResult.result.rowCount, 2);
assert.equal(queryResult.query, "select id, name from parent order by id LIMIT 2");
assert.deepEqual(queryResult.result.rows.map((row) => row.name), ["alpha", "beta"]);
assert.match(JSON.stringify(queryResult), /^\{(?:(?!super-secret-password).)*\}$/s, "query result redacts env secrets");

queryResult = await runSQLiteQueryTool(policy, { workspacePath: workspace, alias: "system", query: "pragma table_info(parent)" });
assert.equal(queryResult.result.rows.some((row) => row.name === "name"), true);

const diagnostics = await runSQLiteDiagnosticsTool(policy, { workspacePath: workspace, alias: "system" });
assert.equal(diagnostics.ok, true);
assert.equal(diagnostics.source.path, path.join("[workspace]", "var", "platform_system.sqlite"));
assert.equal(diagnostics.checks.some((check) => check.name === "table_list"), true);
assert.equal(diagnostics.checks.some((check) => check.name === "index_inventory"), true);

const outside = path.join(os.tmpdir(), `outside-${Date.now()}.sqlite`);
writeFixture(outside);
process.env.CONSOLE_MCP_SQLITE_OUTSIDE_URL = `sqlite:///${outside.replaceAll("\\", "/")}`;
mustReject(() => resolveSQLiteConnection(policy, undefined, "outside"), /outside allowed roots/, "sqlite rejects path outside allowed roots");
delete process.env.CONSOLE_MCP_SQLITE_OUTSIDE_URL;

process.env.CONSOLE_MCP_SQLITE_MISSING_URL = `sqlite:///${path.join(tmp, "missing.sqlite").replaceAll("\\", "/")}`;
mustReject(() => resolveSQLiteConnection(policy, undefined, "missing"), /does not exist/, "sqlite reports missing database");
delete process.env.CONSOLE_MCP_SQLITE_MISSING_URL;

const invalid = path.join(tmp, "invalid.sqlite");
fs.writeFileSync(invalid, "not sqlite");
process.env.CONSOLE_MCP_SQLITE_INVALID_URL = `sqlite:///${invalid.replaceAll("\\", "/")}`;
mustReject(() => resolveSQLiteConnection(policy, undefined, "invalid"), /valid SQLite header/, "sqlite rejects invalid database");
delete process.env.CONSOLE_MCP_SQLITE_INVALID_URL;

const before = fs.statSync(sqlitePath).mtimeMs;
await runSQLiteQueryTool(policy, { workspacePath: workspace, alias: "system", query: "select payload from child", limit: 1 });
const after = fs.statSync(sqlitePath).mtimeMs;
assert.equal(after, before, "sqlite fixture mtime is unchanged by read-only query");

console.log(JSON.stringify({
  ok: true,
  sqlitePath,
  assertions: {
    postgresGuard: true,
    sqliteGuard: true,
    workspaceResolution: true,
    aliasResolution: true,
    diagnostics: true,
    pathSafety: true,
    readOnlyFileBehavior: true,
    secretRedaction: true,
  },
}, null, 2));
