import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import initSqlJs from "sql.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { assertAllowedRoot, isWithinRoot } from "../Policy/PathGuard.js";
import { normalizePath, type ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { buildSafeEnv, resolveCommandExecutable, sanitizeText } from "../Infrastructure/Process/ProcessRuntime.js";
import { listGoogleAdsEditorDatabases } from "../service/google-ads-editor.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";

const execFileAsync = promisify(execFile);
const commandEngines = ["postgres", "mysql"] as const;
type CommandDatabaseEngine = (typeof commandEngines)[number];

type CommandConnectionResolution = {
  engine: CommandDatabaseEngine;
  alias: string;
  url: URL;
  source: {
    kind: "process_env" | "workspace_env";
    name: string;
    workspacePath?: string;
  };
};

type SQLiteConnectionResolution = {
  engine: "sqlite";
  alias: string;
  path: string;
  source: {
    kind: "process_env" | "workspace_env" | "workspace_doctrine" | "google_ads_editor";
    name: string;
    workspacePath?: string;
    connection?: string;
    entityManager?: string;
    url?: string;
  };
};

type CommandRun = {
  ok: boolean;
  client: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

type SQLiteQueryResult = {
  ok: boolean;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  maxRows: number;
  maxBytes: number;
  bytes: number;
  bytesTruncated: boolean;
};

type QueryInput = {
  workspacePath?: string;
  alias?: string;
  query: string;
  limit?: number;
  timeoutMs?: number;
};

type DiagnosticInput = {
  workspacePath?: string;
  alias?: string;
  timeoutMs?: number;
};

type WorkspaceEnv = {
  values: Record<string, string>;
  sources: Record<string, string>;
};

const sqliteHeader = Buffer.from("SQLite format 3\0", "utf8");
const maxOutputBytes = 1024 * 1024;
const maxShownBytes = 12000;
const defaultRowLimit = 200;
const hardRowLimit = 500;
const defaultSqliteMaxBytes = 524288;

let sqlModulePromise: ReturnType<typeof initSqlJs> | null = null;

export function registerDatabaseTools(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  const querySchema = z.object({
    workspacePath: z.string().min(1).optional(),
    alias: z.string().min(1).optional(),
    query: z.string().min(1),
    limit: z.number().int().min(1).max(hardRowLimit).optional(),
    timeoutMs: z.number().int().min(1000).max(30000).optional(),
  }).strict();

  const diagnosticsSchema = z.object({
    workspacePath: z.string().min(1).optional(),
    alias: z.string().min(1).optional(),
    timeoutMs: z.number().int().min(1000).max(30000).optional(),
  }).strict();

  server.registerTool(
    "console.read_.database.sql.postgres.query",
    {
      description: "Run a guarded read-only PostgreSQL query.",
      inputSchema: querySchema,
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(await runCommandQueryTool(policy, "postgres", input))
  );

  server.registerTool(
    "console.read_.database.sql.postgres.diagnostics",
    {
      description: "Run safe PostgreSQL diagnostics.",
      inputSchema: diagnosticsSchema,
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(await runCommandDiagnosticsTool(policy, "postgres", input))
  );

  server.registerTool(
    "console.read_.database.sql.mysql.query",
    {
      description: "Run a guarded read-only MySQL query.",
      inputSchema: querySchema,
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(await runCommandQueryTool(policy, "mysql", input))
  );

  server.registerTool(
    "console.read_.database.sql.mysql.diagnostics",
    {
      description: "Run safe MySQL diagnostics.",
      inputSchema: diagnosticsSchema,
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(await runCommandDiagnosticsTool(policy, "mysql", input))
  );

  server.registerTool(
    "console.read_.database.sql.sqlite.query",
    {
      description: "Run a guarded read-only SQLite query against a resolved workspace/configuration alias.",
      inputSchema: querySchema,
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(await runSQLiteQueryTool(policy, input))
  );

  server.registerTool(
    "console.read_.database.sql.sqlite.diagnostics",
    {
      description: "Run safe bounded SQLite diagnostics against a resolved workspace/configuration alias.",
      inputSchema: diagnosticsSchema,
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(await runSQLiteDiagnosticsTool(policy, input))
  );
}

async function runCommandQueryTool(policy: ConsolePolicy, engine: CommandDatabaseEngine, input: QueryInput): Promise<Record<string, unknown>> {
  const connection = resolveCommandConnection(policy, engine, input.workspacePath, input.alias);
  const maxRows = clampLimit(input.limit);
  const timeoutMs = input.timeoutMs ?? 15000;
  const safeQuery = withRowLimit(validateReadOnlyCommandQuery(input.query, engine), maxRows);
  const result = await executeDatabaseQuery(connection, safeQuery, timeoutMs);
  return {
    ok: result.ok,
    engine,
    alias: connection.alias,
    source: sanitizeCommandSource(connection),
    query: safeQuery,
    maxRows,
    timeoutMs,
    result,
  };
}

export async function runPostgresQueryTool(policy: ConsolePolicy, input: QueryInput): Promise<Record<string, unknown>> {
  return await runCommandQueryTool(policy, "postgres", input);
}

export async function runPostgresDiagnosticsTool(policy: ConsolePolicy, input: DiagnosticInput): Promise<Record<string, unknown>> {
  return await runCommandDiagnosticsTool(policy, "postgres", input);
}

async function runCommandDiagnosticsTool(policy: ConsolePolicy, engine: CommandDatabaseEngine, input: DiagnosticInput): Promise<Record<string, unknown>> {
  const connection = resolveCommandConnection(policy, engine, input.workspacePath, input.alias);
  const timeoutMs = input.timeoutMs ?? 15000;
  const diagnostics = engine === "postgres" ? postgresDiagnosticQueries() : mysqlDiagnosticQueries();
  const checks = [];
  for (const diagnostic of diagnostics) {
    checks.push({
      name: diagnostic.name,
      result: await executeDatabaseQuery(connection, validateReadOnlyCommandQuery(diagnostic.query, engine), timeoutMs),
    });
  }

  return {
    ok: checks.every((item) => item.result.ok),
    engine,
    alias: connection.alias,
    source: sanitizeCommandSource(connection),
    timeoutMs,
    checks,
  };
}

export async function runSQLiteQueryTool(policy: ConsolePolicy, input: QueryInput): Promise<Record<string, unknown>> {
  const connection = resolveSQLiteConnection(policy, input.workspacePath, input.alias);
  const maxRows = clampLimit(input.limit);
  const timeoutMs = input.timeoutMs ?? 15000;
  const safeQuery = withRowLimit(validateReadOnlySQLiteQuery(input.query), maxRows);
  const result = await executeSQLiteQuery(connection, safeQuery, maxRows);
  return {
    ok: result.ok,
    engine: "sqlite",
    alias: connection.alias,
    source: sanitizeSQLiteSource(connection),
    query: safeQuery,
    maxRows,
    timeoutMs,
    result,
  };
}

export async function runSQLiteDiagnosticsTool(policy: ConsolePolicy, input: DiagnosticInput): Promise<Record<string, unknown>> {
  const connection = resolveSQLiteConnection(policy, input.workspacePath, input.alias);
  const timeoutMs = input.timeoutMs ?? 15000;
  const file = statSync(connection.path);
  const diagnostics = sqliteDiagnosticQueries();
  const checks = [];
  for (const diagnostic of diagnostics) {
    checks.push({
      name: diagnostic.name,
      result: await executeSQLiteQuery(connection, validateReadOnlySQLiteQuery(diagnostic.query), hardRowLimit),
    });
  }

  return {
    ok: checks.every((item) => item.result.ok),
    engine: "sqlite",
    alias: connection.alias,
    source: sanitizeSQLiteSource(connection),
    file: {
      size: file.size,
      lastWriteTime: file.mtime.toISOString(),
    },
    timeoutMs,
    checks,
  };
}

function resolveCommandConnection(policy: ConsolePolicy, engine: CommandDatabaseEngine, workspacePath: string | undefined, aliasInput: string | undefined): CommandConnectionResolution {
  const alias = normalizeAlias(aliasInput ?? "app");
  const suffix = alias.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const envPrefix = engine === "postgres" ? "CONSOLE_MCP_POSTGRES" : "CONSOLE_MCP_MYSQL";
  const directProcessNames = [`${envPrefix}_${suffix}_URL`, `${envPrefix}_URL`];

  for (const name of directProcessNames) {
    const value = process.env[name];
    if (value && isEngineUrl(engine, value)) {
      return { engine, alias, url: parseDatabaseUrl(engine, value), source: { kind: "process_env", name } };
    }
  }

  if (workspacePath) {
    const workspace = assertAllowedRoot(workspacePath, policy.allowedRoots);
    const workspaceEnv = readWorkspaceEnv(workspace);
    const workspaceNames = [`${envPrefix}_${suffix}_URL`, `${envPrefix}_URL`, engine === "postgres" ? "POSTGRES_URL" : "MYSQL_URL", "DATABASE_URL"];
    for (const name of workspaceNames) {
      const value = workspaceEnv.values[name];
      if (value && isEngineUrl(engine, value)) {
        return { engine, alias, url: parseDatabaseUrl(engine, value), source: { kind: "workspace_env", name, workspacePath: workspace } };
      }
    }
  }

  throw new Error(`No ${engine} connection URL found for alias "${alias}". Configure ${envPrefix}_${suffix}_URL, ${envPrefix}_URL, or pass a workspacePath containing a matching Symfony DATABASE_URL.`);
}

export function resolveSQLiteConnection(policy: ConsolePolicy, workspacePath: string | undefined, aliasInput: string | undefined): SQLiteConnectionResolution {
  const alias = normalizeAlias(aliasInput ?? "sqlite");
  const suffix = alias.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const directNames = [`CONSOLE_MCP_SQLITE_${suffix}_URL`, `CONSOLE_MCP_SQLITE_${suffix}_PATH`, "CONSOLE_MCP_SQLITE_URL"];

  for (const name of directNames) {
    const value = process.env[name];
    if (value) {
      const resolvedPath = resolveSQLitePathValue(value, process.cwd());
      return validateSQLiteFile(policy, {
        engine: "sqlite",
        alias,
        path: resolvedPath,
        source: { kind: "process_env", name, url: sanitizeSQLitePathValue(value) },
      });
    }
  }

  if (workspacePath) {
    const workspace = assertAllowedRoot(workspacePath, policy.allowedRoots);
    const workspaceEnv = readWorkspaceEnv(workspace);
    const workspaceNames = [
      `CONSOLE_MCP_SQLITE_${suffix}_URL`,
      `CONSOLE_MCP_SQLITE_${suffix}_PATH`,
      "CONSOLE_MCP_SQLITE_URL",
      `${suffix}_DATABASE_URL`,
      `${suffix}_DATABASE`,
      "PLATFORM_SYSTEM_DATABASE",
    ];
    for (const name of workspaceNames) {
      const value = workspaceEnv.values[name];
      if (value && isSQLitePathValue(value)) {
        const resolvedPath = resolveSQLitePathValue(value, workspace);
        return validateSQLiteFile(policy, {
          engine: "sqlite",
          alias,
          path: resolvedPath,
          source: { kind: "workspace_env", name, workspacePath: workspace, url: sanitizeSQLitePathValue(value) },
        });
      }
    }

    const doctrine = resolveSQLiteFromDoctrineWorkspace(workspace, alias);
    if (doctrine) {
      return validateSQLiteFile(policy, {
        engine: "sqlite",
        alias,
        path: doctrine.path,
        source: {
          kind: "workspace_doctrine",
          name: doctrine.configName,
          workspacePath: workspace,
          connection: doctrine.connection,
          entityManager: doctrine.entityManager,
        },
      });
    }
  }

  if (alias.startsWith("google_ads_editor.")) {
    const database = listGoogleAdsEditorDatabases().databases.find((item) => item.alias === alias);
    if (!database) {
      throw new Error(`Unknown Google Ads Editor database alias: ${alias}`);
    }

    return validateSQLiteFile(policy, {
      engine: "sqlite",
      alias,
      path: database.path,
      source: { kind: "google_ads_editor", name: alias },
    });
  }

  throw new Error(`No SQLite database found for alias "${alias}". Configure CONSOLE_MCP_SQLITE_${suffix}_URL, CONSOLE_MCP_SQLITE_URL, or pass a workspacePath with a Symfony Doctrine SQLite connection.`);
}

function validateSQLiteFile(policy: ConsolePolicy, connection: SQLiteConnectionResolution): SQLiteConnectionResolution {
  const resolvedPath = normalizePath(connection.path);
  if (resolvedPath.startsWith("\\\\")) {
    throw new Error("SQLite database path must not be a network/UNC path.");
  }

  const allowedRoots = [...policy.allowedRoots, ...parsePathList(process.env.CONSOLE_MCP_SQLITE_ALLOWED_ROOTS)];
  if (connection.source.kind === "google_ads_editor") {
    allowedRoots.push(path.dirname(resolvedPath));
  }

  if (!allowedRoots.some((root) => isWithinRoot(resolvedPath, root))) {
    throw new Error("SQLite database path is outside allowed roots.");
  }

  if (!existsSync(resolvedPath)) {
    throw new Error(`SQLite database file does not exist for alias "${connection.alias}".`);
  }

  const stat = statSync(resolvedPath);
  if (!stat.isFile()) {
    throw new Error("SQLite database path is not a regular file.");
  }

  if (!hasSQLiteHeader(resolvedPath)) {
    throw new Error("SQLite database file does not have a valid SQLite header.");
  }

  return { ...connection, path: resolvedPath };
}

function readWorkspaceEnv(workspace: string): WorkspaceEnv {
  const names = [".env", ".env.local", ".env.dev", ".env.dev.local", ".env.test.local"];
  const values: Record<string, string> = {};
  const sources: Record<string, string> = {};
  for (const name of names) {
    const filePath = path.join(workspace, name);
    if (!existsSync(filePath)) {
      continue;
    }

    const parsed = parseEnvText(readFileSync(filePath, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      values[key] = value;
      sources[key] = name;
    }
  }

  return { values, sources };
}

function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }

    out[match[1]] = unwrapEnvValue(match[2].trim());
  }

  return out;
}

function unwrapEnvValue(value: string): string {
  const withoutComment = value.replace(/\s+#.*$/u, "").trim();
  if ((withoutComment.startsWith('"') && withoutComment.endsWith('"')) || (withoutComment.startsWith("'") && withoutComment.endsWith("'"))) {
    return withoutComment.slice(1, -1);
  }

  return withoutComment;
}

function resolveSQLiteFromDoctrineWorkspace(workspace: string, alias: string): { path: string; connection: string; entityManager?: string; configName: string } | null {
  const candidates = [
    path.join(workspace, "config", "packages", "doctrine.yaml"),
    path.join(workspace, "config", "packages", "doctrine.prod.yaml"),
  ].filter((filePath) => existsSync(filePath));

  for (const configPath of candidates) {
    const text = readFileSync(configPath, "utf8");
    const connections = parseDoctrineConnectionPaths(text);
    const entityManagers = parseDoctrineEntityManagers(text);
    const direct = connections.get(alias);
    if (direct) {
      return { path: resolveSymfonyPath(direct, workspace), connection: alias, configName: path.relative(workspace, configPath) };
    }

    const entityConnection = entityManagers.get(alias);
    if (entityConnection && connections.has(entityConnection)) {
      return {
        path: resolveSymfonyPath(connections.get(entityConnection) as string, workspace),
        connection: entityConnection,
        entityManager: alias,
        configName: path.relative(workspace, configPath),
      };
    }
  }

  return null;
}

function parseDoctrineConnectionPaths(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  let inConnections = false;
  let connectionsIndent = -1;
  let currentConnection: string | null = null;
  let currentConnectionIndent = -1;

  for (const raw of lines) {
    const withoutComment = raw.replace(/\s+#.*$/u, "");
    if (!withoutComment.trim()) {
      continue;
    }

    const indent = withoutComment.match(/^ */u)?.[0].length ?? 0;
    const trimmed = withoutComment.trim();
    if (trimmed === "connections:") {
      inConnections = true;
      connectionsIndent = indent;
      currentConnection = null;
      continue;
    }

    if (!inConnections) {
      continue;
    }

    if (indent <= connectionsIndent) {
      inConnections = false;
      currentConnection = null;
      continue;
    }

    const key = trimmed.match(/^([A-Za-z0-9_.-]+):\s*$/u);
    if (key && indent === connectionsIndent + 4) {
      currentConnection = key[1];
      currentConnectionIndent = indent;
      continue;
    }

    if (currentConnection && indent > currentConnectionIndent) {
      const pathMatch = trimmed.match(/^path:\s*(.+)$/u);
      if (pathMatch) {
        out.set(currentConnection, unwrapYamlScalar(pathMatch[1]));
      }
      const urlMatch = trimmed.match(/^url:\s*(.+)$/u);
      if (urlMatch) {
        const value = unwrapYamlScalar(urlMatch[1]);
        if (isSQLitePathValue(value)) {
          out.set(currentConnection, value);
        }
      }
    }
  }

  return out;
}

function parseDoctrineEntityManagers(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  let inEntityManagers = false;
  let entityManagersIndent = -1;
  let currentManager: string | null = null;
  let currentManagerIndent = -1;

  for (const raw of lines) {
    const withoutComment = raw.replace(/\s+#.*$/u, "");
    if (!withoutComment.trim()) {
      continue;
    }

    const indent = withoutComment.match(/^ */u)?.[0].length ?? 0;
    const trimmed = withoutComment.trim();
    if (trimmed === "entity_managers:") {
      inEntityManagers = true;
      entityManagersIndent = indent;
      currentManager = null;
      continue;
    }

    if (!inEntityManagers) {
      continue;
    }

    if (indent <= entityManagersIndent) {
      inEntityManagers = false;
      currentManager = null;
      continue;
    }

    const key = trimmed.match(/^([A-Za-z0-9_.-]+):\s*$/u);
    if (key && indent === entityManagersIndent + 4) {
      currentManager = key[1];
      currentManagerIndent = indent;
      continue;
    }

    if (currentManager && indent > currentManagerIndent) {
      const connectionMatch = trimmed.match(/^connection:\s*(.+)$/u);
      if (connectionMatch) {
        out.set(currentManager, unwrapYamlScalar(connectionMatch[1]));
      }
    }
  }

  return out;
}

function unwrapYamlScalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function resolveSymfonyPath(value: string, workspace: string): string {
  const resolved = resolveSQLitePathValue(value.replaceAll("%kernel.project_dir%", workspace), workspace);
  return normalizePath(resolved);
}

function isEngineUrl(engine: CommandDatabaseEngine, value: string): boolean {
  const trimmed = value.trim();
  if (engine === "postgres") {
    return /^(postgres|postgresql|pgsql):\/\//i.test(trimmed);
  }

  return /^(mysql|mariadb):\/\//i.test(trimmed);
}

function parseDatabaseUrl(engine: CommandDatabaseEngine, value: string): URL {
  const normalized = value.trim().replace(/^pgsql:\/\//i, "postgresql://");
  const url = new URL(normalized);
  if (!isEngineUrl(engine, normalized)) {
    throw new Error(`Connection URL does not match ${engine}.`);
  }

  if (!url.hostname) {
    throw new Error("Database URL host is required.");
  }

  return url;
}

function isSQLitePathValue(value: string): boolean {
  const trimmed = value.trim();
  return /^sqlite:\/\//iu.test(trimmed) || trimmed.length > 0 && !/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed);
}

function resolveSQLitePathValue(value: string, workspace: string): string {
  const workspaceForUrl = workspace.replaceAll("\\", "/");
  const trimmed = value.trim().replaceAll("%kernel.project_dir%", /^sqlite:\/\//iu.test(value.trim()) ? workspaceForUrl : workspace);
  if (/^sqlite:\/\//iu.test(trimmed)) {
    const url = new URL(trimmed);
    if (url.hostname) {
      throw new Error("SQLite URLs with hosts are not supported.");
    }

    return sqliteUrlPathnameToPath(decodeURIComponent(url.pathname));
  }

  return path.isAbsolute(trimmed) ? normalizePath(trimmed) : normalizePath(path.join(workspace, trimmed));
}

function sqliteUrlPathnameToPath(pathname: string): string {
  return /^\/[A-Za-z]:\//u.test(pathname) ? pathname.slice(1) : pathname;
}

function sanitizeSQLitePathValue(value: string): string {
  const trimmed = value.trim();
  if (!/^sqlite:\/\//iu.test(trimmed)) {
    return "[path]";
  }

  try {
    const url = new URL(trimmed.replaceAll("%kernel.project_dir%", "[project]"));
    return `sqlite://${url.hostname ? "[host]" : ""}${url.pathname.replace(/[^/]+$/u, "[database]")}`;
  } catch {
    return "sqlite://[redacted]";
  }
}

async function executeDatabaseQuery(connection: CommandConnectionResolution, query: string, timeoutMs: number): Promise<CommandRun> {
  return connection.engine === "postgres"
    ? await executePostgresQuery(connection, query, timeoutMs)
    : await executeMySqlQuery(connection, query, timeoutMs);
}

async function executePostgresQuery(connection: CommandConnectionResolution, query: string, timeoutMs: number): Promise<CommandRun> {
  const command = resolveCommandExecutable(process.env.CONSOLE_MCP_PSQL_BIN || "psql");
  const args = [
    "-X",
    "--no-psqlrc",
    "--csv",
    "--set",
    "ON_ERROR_STOP=1",
    "--host",
    connection.url.hostname,
    "--port",
    connection.url.port || "5432",
  ];

  if (connection.url.username) {
    args.push("--username", decodeURIComponent(connection.url.username));
  }

  const database = decodeURIComponent(connection.url.pathname.replace(/^\//u, ""));
  if (database) {
    args.push("--dbname", database);
  }

  args.push("--command", query);

  const env: Record<string, string> = {
    ...buildSafeEnv(),
    PGCONNECT_TIMEOUT: "5",
  };

  if (connection.url.password) {
    env.PGPASSWORD = decodeURIComponent(connection.url.password);
  }

  const sslMode = connection.url.searchParams.get("sslmode");
  if (sslMode) {
    env.PGSSLMODE = sslMode;
  }

  return await runClient(command, args, env, process.cwd(), timeoutMs, collectCommandSecrets(connection));
}

async function executeMySqlQuery(connection: CommandConnectionResolution, query: string, timeoutMs: number): Promise<CommandRun> {
  const command = resolveCommandExecutable(process.env.CONSOLE_MCP_MYSQL_BIN || "mysql");
  const args = [
    "--protocol=TCP",
    "--host",
    connection.url.hostname,
    "--port",
    connection.url.port || "3306",
    "--batch",
    "--raw",
    "--default-character-set=utf8mb4",
    "--connect-timeout=5",
  ];

  if (connection.url.username) {
    args.push("--user", decodeURIComponent(connection.url.username));
  }

  const database = decodeURIComponent(connection.url.pathname.replace(/^\//u, ""));
  if (database) {
    args.push("--database", database);
  }

  args.push("--execute", query);

  const env: Record<string, string> = buildSafeEnv();
  if (connection.url.password) {
    env.MYSQL_PWD = decodeURIComponent(connection.url.password);
  }

  return await runClient(command, args, env, process.cwd(), timeoutMs, collectCommandSecrets(connection));
}

async function runClient(command: string, args: string[], env: Record<string, string>, cwd: string, timeoutMs: number, secrets: string[]): Promise<CommandRun> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: maxOutputBytes,
      env,
    });

    return {
      ok: true,
      client: path.basename(command),
      args: sanitizeArgs(args),
      cwd,
      exitCode: 0,
      ...sanitizeOutput(String(result.stdout ?? ""), String(result.stderr ?? ""), secrets),
    };
  } catch (error) {
    const captured = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | null };
    return {
      ok: false,
      client: path.basename(command),
      args: sanitizeArgs(args),
      cwd,
      exitCode: typeof captured.code === "number" ? captured.code : null,
      ...sanitizeOutput(String(captured.stdout ?? ""), String(captured.stderr ?? captured.message ?? error), secrets),
    };
  }
}

async function executeSQLiteQuery(connection: SQLiteConnectionResolution, query: string, maxRows: number): Promise<SQLiteQueryResult> {
  const maxBytes = Number(process.env.CONSOLE_MCP_SQLITE_MAX_BYTES || defaultSqliteMaxBytes);
  const SQL = await loadSqlModule();
  const bytes = readFileSync(connection.path);
  const db = new SQL.Database(bytes);

  try {
    const result = db.exec(query);
    const first = result[0] || { columns: [], values: [] };
    const rows = first.values.slice(0, maxRows).map((values: unknown[]) => rowFromColumns(first.columns, values));
    const payload = { ok: true, columns: first.columns, rows, rowCount: rows.length, maxRows };
    const size = Buffer.byteLength(JSON.stringify(payload), "utf8");
    if (size > maxBytes) {
      return { ok: true, columns: first.columns, rows: [], rowCount: 0, maxRows, maxBytes, bytes: size, bytesTruncated: true };
    }

    return { ...payload, maxBytes, bytes: size, bytesTruncated: false };
  } finally {
    db.close();
  }
}

function sanitizeOutput(stdout: string, stderr: string, secrets: string[]): Pick<CommandRun, "stdout" | "stderr" | "stdoutTruncated" | "stderrTruncated"> {
  const safeStdout = truncateText(redactSecrets(sanitizeText(stdout), secrets), maxShownBytes);
  const safeStderr = truncateText(redactSecrets(sanitizeText(stderr), secrets), maxShownBytes);
  return {
    stdout: safeStdout.text,
    stderr: safeStderr.text,
    stdoutTruncated: safeStdout.truncated,
    stderrTruncated: safeStderr.truncated,
  };
}

function sanitizeArgs(args: string[]): string[] {
  const sanitized = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    sanitized.push(arg);
    if (arg === "--command" || arg === "--execute") {
      sanitized.push("[sql]");
      index += 1;
    }
  }

  return sanitized;
}

export function validateReadOnlyCommandQuery(query: string, engine: CommandDatabaseEngine): string {
  const statement = normalizeSingleStatement(query);
  if (!/^(select|with|show|explain)\b/iu.test(statement)) {
    throw new Error("Only SELECT, WITH, SHOW, or EXPLAIN statements are allowed.");
  }

  if (engine === "postgres" && /^show\s+all\b/iu.test(statement)) {
    throw new Error("SHOW ALL is blocked because it can expose configuration secrets.");
  }

  if (/\b(insert|update|delete|merge|replace|alter|drop|create|truncate|grant|revoke|vacuum|analyze|reindex|copy|call|do|execute|prepare|deallocate|listen|notify|lock|set|reset|use|delimiter|handler|load|outfile|infile)\b/iu.test(statement)) {
    throw new Error("Blocked SQL keyword.");
  }

  if (/\b(pg_sleep|sleep|benchmark|load_file|dblink|lo_import|lo_export)\b/iu.test(statement)) {
    throw new Error("Blocked unsafe SQL function.");
  }

  return statement;
}

export function validateReadOnlySQLiteQuery(query: string): string {
  const statement = normalizeSingleStatement(query);
  if (/^(select|with|explain)\b/iu.test(statement)) {
    if (/\b(insert|update|delete|merge|replace|alter|drop|create|truncate|vacuum|analyze|reindex|attach|detach|pragma\s+writable_schema|load_extension)\b/iu.test(statement)) {
      throw new Error("Blocked SQL keyword.");
    }

    return statement;
  }

  if (/^pragma\b/iu.test(statement)) {
    if (!isSafeSQLitePragma(statement)) {
      throw new Error("Only explicitly safe read-only SQLite PRAGMA calls are allowed.");
    }

    return statement;
  }

  throw new Error("Only SELECT, WITH, EXPLAIN, or safe PRAGMA statements are allowed.");
}

function normalizeSingleStatement(query: string): string {
  const normalized = String(query || "").trim().replace(/\s+/gu, " ");
  const statement = normalized.endsWith(";") ? normalized.slice(0, -1).trim() : normalized;
  if (!statement || statement.includes(";")) {
    throw new Error("Exactly one SQL statement is required.");
  }

  if (/--|\/\*|\*\//u.test(statement)) {
    throw new Error("SQL comments are not allowed.");
  }

  return statement;
}

function isSafeSQLitePragma(statement: string): boolean {
  return [
    /^pragma\s+table_list\s*$/iu,
    /^pragma\s+table_info\s*\(\s*['"`]?[A-Za-z0-9_.-]+['"`]?\s*\)\s*$/iu,
    /^pragma\s+table_xinfo\s*\(\s*['"`]?[A-Za-z0-9_.-]+['"`]?\s*\)\s*$/iu,
    /^pragma\s+index_list\s*\(\s*['"`]?[A-Za-z0-9_.-]+['"`]?\s*\)\s*$/iu,
    /^pragma\s+index_info\s*\(\s*['"`]?[A-Za-z0-9_.-]+['"`]?\s*\)\s*$/iu,
    /^pragma\s+index_xinfo\s*\(\s*['"`]?[A-Za-z0-9_.-]+['"`]?\s*\)\s*$/iu,
    /^pragma\s+foreign_key_list\s*\(\s*['"`]?[A-Za-z0-9_.-]+['"`]?\s*\)\s*$/iu,
    /^pragma\s+(database_list|foreign_keys|encoding|page_count|page_size|schema_version|user_version|application_id|freelist_count|quick_check|integrity_check)\s*$/iu,
  ].some((pattern) => pattern.test(statement));
}

function withRowLimit(query: string, limit: number): string {
  if (/^(select|with)\b/iu.test(query) && !/\blimit\s+\d+\b/iu.test(query)) {
    return `${query} LIMIT ${limit}`;
  }

  return query;
}

function postgresDiagnosticQueries(): Array<{ name: string; query: string }> {
  return [
    { name: "version", query: "select version()" },
    { name: "identity", query: "select current_database() as database, current_schema() as schema, current_user as user, inet_server_addr() as server_addr, inet_server_port() as server_port" },
    { name: "table_list", query: "select table_schema, table_name, table_type from information_schema.tables where table_schema not in ('pg_catalog','information_schema') order by table_schema, table_name limit 200" },
    { name: "table_size", query: "select schemaname as schema, relname as table_name, pg_size_pretty(pg_total_relation_size(relid)) as total_size from pg_catalog.pg_statio_user_tables order by pg_total_relation_size(relid) desc limit 50" },
    { name: "connection_summary", query: "select state, count(*) as count from pg_stat_activity group by state order by count desc" },
    { name: "doctrine_migration_table", query: "select table_schema, table_name from information_schema.tables where table_name = 'doctrine_migration_versions' order by table_schema limit 20" },
    { name: "extensions", query: "select extname, extversion from pg_catalog.pg_extension order by extname limit 100" },
    { name: "invalid_indexes", query: "select ns.nspname as schema, cls.relname as index_name from pg_catalog.pg_index idx join pg_catalog.pg_class cls on cls.oid = idx.indexrelid join pg_catalog.pg_namespace ns on ns.oid = cls.relnamespace where idx.indisvalid = false order by ns.nspname, cls.relname limit 100" },
  ];
}

function mysqlDiagnosticQueries(): Array<{ name: string; query: string }> {
  return [
    { name: "version", query: "select version() as version, database() as database_name, user() as user_name" },
    { name: "table_list", query: "select table_schema, table_name, table_type, engine from information_schema.tables where table_schema = database() order by table_name limit 200" },
    { name: "table_size", query: "select table_name, engine, table_rows, data_length, index_length from information_schema.tables where table_schema = database() order by (data_length + index_length) desc limit 50" },
    { name: "process_summary", query: "select command, state, count(*) as count from information_schema.processlist group by command, state order by count desc" },
    { name: "doctrine_migration_table", query: "select table_schema, table_name from information_schema.tables where table_name = 'doctrine_migration_versions' order by table_schema limit 20" },
  ];
}

function sqliteDiagnosticQueries(): Array<{ name: string; query: string }> {
  return [
    { name: "version", query: "select sqlite_version() as version" },
    { name: "database_list", query: "pragma database_list" },
    { name: "table_list", query: "pragma table_list" },
    { name: "table_inventory", query: "select type, name, tbl_name from sqlite_schema where type in ('table','view') and name not like 'sqlite_%' order by type, name limit 200" },
    { name: "index_inventory", query: "select name, tbl_name, sql is not null as has_sql from sqlite_schema where type = 'index' and name not like 'sqlite_%' order by tbl_name, name limit 200" },
    { name: "foreign_key_table_count", query: "select count(*) as table_count from sqlite_schema where type = 'table' and sql like '%FOREIGN KEY%' limit 1" },
    { name: "doctrine_migration_table", query: "select name from sqlite_schema where type = 'table' and name = 'doctrine_migration_versions' limit 20" },
  ];
}

function normalizeAlias(alias: string): string {
  const normalized = alias.trim().toLowerCase();
  if (!/^[a-z0-9_.-]{1,96}$/u.test(normalized)) {
    throw new Error("Database alias may contain only letters, numbers, dot, dash, and underscore.");
  }

  return normalized;
}

function clampLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(Number(limit || defaultRowLimit), hardRowLimit));
}

function collectCommandSecrets(connection: CommandConnectionResolution): string[] {
  const values = [
    connection.url.href,
    connection.url.password,
    decodeURIComponent(connection.url.password || ""),
  ].filter((value) => value.length >= 4);

  return Array.from(new Set(values));
}

function redactSecrets(text: string, secrets: string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join("[redacted]");
  }

  return redacted;
}

function sanitizeCommandSource(connection: CommandConnectionResolution): Record<string, unknown> {
  return {
    ...connection.source,
    url: redactDatabaseUrl(connection.url),
  };
}

function sanitizeSQLiteSource(connection: SQLiteConnectionResolution): Record<string, unknown> {
  return {
    ...connection.source,
    path: safeDisplayPath(connection.path, connection.source.workspacePath),
  };
}

function redactDatabaseUrl(url: URL): string {
  const clone = new URL(url.href);
  if (clone.password) {
    clone.password = "[redacted]";
  }

  return clone.href;
}

function safeDisplayPath(filePath: string, workspacePath: string | undefined): string {
  if (workspacePath && isWithinRoot(filePath, workspacePath)) {
    return path.join("[workspace]", path.relative(workspacePath, filePath));
  }

  return path.join(path.dirname(filePath), path.basename(filePath));
}

function truncateText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) {
    return { text, truncated: false };
  }

  return {
    text: buffer.subarray(0, maxBytes).toString("utf8"),
    truncated: true,
  };
}

function parsePathList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value.split(";").map((item) => item.trim()).filter((item) => item.length > 0).map(normalizePath);
}

function hasSQLiteHeader(filePath: string): boolean {
  const stat = statSync(filePath);
  if (!stat.isFile() || stat.size <= sqliteHeader.length) {
    return false;
  }

  const fd = openSync(filePath, "r");
  try {
    const header = Buffer.alloc(sqliteHeader.length);
    readSync(fd, header, 0, header.length, 0);
    return header.equals(sqliteHeader);
  } finally {
    closeSync(fd);
  }
}

async function loadSqlModule(): Promise<Awaited<ReturnType<typeof initSqlJs>>> {
  sqlModulePromise ??= initSqlJs();
  return sqlModulePromise;
}

function rowFromColumns(columns: string[], values: unknown[]): Record<string, unknown> {
  return Object.fromEntries(columns.map((column, index) => [column, sanitizeSQLiteValue(values[index])]));
}

function sanitizeSQLiteValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return `[blob ${value.byteLength} bytes]`;
  }

  return value;
}

export const databaseToolTestApi = {
  resolveSQLitePathValue,
  validateReadOnlyCommandQuery,
  validateReadOnlySQLiteQuery,
  parseDoctrineConnectionPaths,
  parseDoctrineEntityManagers,
};
