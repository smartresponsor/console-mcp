import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../service/auth.js";
import { assertAllowedRoot } from "../service/path.js";
import type { ConsolePolicy } from "../service/policy.js";
import { buildSafeEnv, resolveCommandExecutable, sanitizeText } from "../service/process.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";

const execFileAsync = promisify(execFile);
const allowedEngines = ["postgres", "mysql"] as const;
type DatabaseEngine = (typeof allowedEngines)[number];

type ConnectionResolution = {
  engine: DatabaseEngine;
  alias: string;
  url: URL;
  source: {
    kind: "process_env" | "workspace_env";
    name: string;
    workspacePath?: string;
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

const maxOutputBytes = 1024 * 1024;
const maxShownBytes = 12000;

export function registerDatabaseTools(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  const querySchema = z.object({
    workspacePath: z.string().min(1).optional(),
    alias: z.string().min(1).optional(),
    query: z.string().min(1),
    limit: z.number().int().min(1).max(500).optional(),
    timeoutMs: z.number().int().min(1000).max(30000).optional(),
  }).strict();

  const diagnosticsSchema = z.object({
    workspacePath: z.string().min(1).optional(),
    alias: z.string().min(1).optional(),
    timeoutMs: z.number().int().min(1000).max(30000).optional(),
  }).strict();

  server.registerTool(
    "console.postgres_query_readonly",
    {
      description: "Run a guarded read-only PostgreSQL query using a configured connection alias or Symfony DATABASE_URL.",
      inputSchema: querySchema,
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(await runQueryTool(policy, "postgres", input))
  );

  server.registerTool(
    "console.read_.database.sql.postgres.query",
    {
      description: "Canonical alias for console.postgres_query_readonly. Run a guarded read-only PostgreSQL query.",
      inputSchema: querySchema,
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(await runQueryTool(policy, "postgres", input))
  );

  server.registerTool(
    "console.postgres_diagnostics",
    {
      description: "Run safe PostgreSQL diagnostics: version, identity, table list, table sizes, connections, and Doctrine migration table presence.",
      inputSchema: diagnosticsSchema,
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(await runDiagnosticsTool(policy, "postgres", input))
  );

  server.registerTool(
    "console.read_.database.sql.postgres.diagnostics",
    {
      description: "Canonical alias for console.postgres_diagnostics. Run safe PostgreSQL diagnostics.",
      inputSchema: diagnosticsSchema,
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(await runDiagnosticsTool(policy, "postgres", input))
  );

  server.registerTool(
    "console.mysql_query_readonly",
    {
      description: "Run a guarded read-only MySQL query using a configured connection alias or Symfony DATABASE_URL.",
      inputSchema: querySchema,
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(await runQueryTool(policy, "mysql", input))
  );

  server.registerTool(
    "console.read_.database.sql.mysql.query",
    {
      description: "Canonical alias for console.mysql_query_readonly. Run a guarded read-only MySQL query.",
      inputSchema: querySchema,
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(await runQueryTool(policy, "mysql", input))
  );

  server.registerTool(
    "console.mysql_diagnostics",
    {
      description: "Run safe MySQL diagnostics: version, identity, table list, table sizes, process summary, and Doctrine migration table presence.",
      inputSchema: diagnosticsSchema,
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(await runDiagnosticsTool(policy, "mysql", input))
  );

  server.registerTool(
    "console.read_.database.sql.mysql.diagnostics",
    {
      description: "Canonical alias for console.mysql_diagnostics. Run safe MySQL diagnostics.",
      inputSchema: diagnosticsSchema,
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(await runDiagnosticsTool(policy, "mysql", input))
  );
}

async function runQueryTool(policy: ConsolePolicy, engine: DatabaseEngine, input: QueryInput): Promise<Record<string, unknown>> {
  const connection = resolveConnection(policy, engine, input.workspacePath, input.alias);
  const maxRows = clampLimit(input.limit);
  const timeoutMs = input.timeoutMs ?? 15000;
  const safeQuery = withRowLimit(validateReadOnlyQuery(input.query, engine), maxRows);
  const result = await executeDatabaseQuery(connection, safeQuery, timeoutMs);
  return {
    ok: result.ok,
    engine,
    alias: connection.alias,
    source: sanitizeSource(connection),
    query: safeQuery,
    maxRows,
    timeoutMs,
    result,
  };
}

async function runDiagnosticsTool(policy: ConsolePolicy, engine: DatabaseEngine, input: DiagnosticInput): Promise<Record<string, unknown>> {
  const connection = resolveConnection(policy, engine, input.workspacePath, input.alias);
  const timeoutMs = input.timeoutMs ?? 15000;
  const diagnostics = engine === "postgres" ? postgresDiagnosticQueries() : mysqlDiagnosticQueries();
  const checks = [];
  for (const diagnostic of diagnostics) {
    checks.push({
      name: diagnostic.name,
      result: await executeDatabaseQuery(connection, validateReadOnlyQuery(diagnostic.query, engine), timeoutMs),
    });
  }

  return {
    ok: checks.every((item) => item.result.ok),
    engine,
    alias: connection.alias,
    source: sanitizeSource(connection),
    timeoutMs,
    checks,
  };
}

function resolveConnection(policy: ConsolePolicy, engine: DatabaseEngine, workspacePath: string | undefined, aliasInput: string | undefined): ConnectionResolution {
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
      const value = workspaceEnv[name];
      if (value && isEngineUrl(engine, value)) {
        return { engine, alias, url: parseDatabaseUrl(engine, value), source: { kind: "workspace_env", name, workspacePath: workspace } };
      }
    }
  }

  throw new Error(`No ${engine} connection URL found for alias "${alias}". Configure ${envPrefix}_${suffix}_URL, ${envPrefix}_URL, or pass a workspacePath containing a matching Symfony DATABASE_URL.`);
}

function readWorkspaceEnv(workspace: string): Record<string, string> {
  const names = [".env", ".env.local", ".env.dev", ".env.dev.local", ".env.test.local"];
  const values: Record<string, string> = {};
  for (const name of names) {
    const filePath = path.join(workspace, name);
    if (!existsSync(filePath)) {
      continue;
    }

    Object.assign(values, parseEnvText(readFileSync(filePath, "utf8")));
  }

  return values;
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

function isEngineUrl(engine: DatabaseEngine, value: string): boolean {
  const trimmed = value.trim();
  if (engine === "postgres") {
    return /^(postgres|postgresql|pgsql):\/\//i.test(trimmed);
  }

  return /^(mysql|mariadb):\/\//i.test(trimmed);
}

function parseDatabaseUrl(engine: DatabaseEngine, value: string): URL {
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

async function executeDatabaseQuery(connection: ConnectionResolution, query: string, timeoutMs: number): Promise<CommandRun> {
  return connection.engine === "postgres"
    ? await executePostgresQuery(connection, query, timeoutMs)
    : await executeMySqlQuery(connection, query, timeoutMs);
}

async function executePostgresQuery(connection: ConnectionResolution, query: string, timeoutMs: number): Promise<CommandRun> {
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

  return await runClient(command, args, env, process.cwd(), timeoutMs, collectSecrets(connection));
}

async function executeMySqlQuery(connection: ConnectionResolution, query: string, timeoutMs: number): Promise<CommandRun> {
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

  return await runClient(command, args, env, process.cwd(), timeoutMs, collectSecrets(connection));
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

function validateReadOnlyQuery(query: string, engine: DatabaseEngine): string {
  const normalized = String(query || "").trim().replace(/\s+/gu, " ");
  const statement = normalized.endsWith(";") ? normalized.slice(0, -1).trim() : normalized;
  if (!statement || statement.includes(";")) {
    throw new Error("Exactly one SQL statement is required.");
  }

  if (/--|\/\*|\*\//u.test(statement)) {
    throw new Error("SQL comments are not allowed.");
  }

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

function normalizeAlias(alias: string): string {
  const normalized = alias.trim().toLowerCase();
  if (!/^[a-z0-9_.-]{1,64}$/u.test(normalized)) {
    throw new Error("Database alias may contain only letters, numbers, dot, dash, and underscore.");
  }

  return normalized;
}

function clampLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(Number(limit || 200), 500));
}

function collectSecrets(connection: ConnectionResolution): string[] {
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

function sanitizeSource(connection: ConnectionResolution): Record<string, unknown> {
  return {
    ...connection.source,
    url: redactDatabaseUrl(connection.url),
  };
}

function redactDatabaseUrl(url: URL): string {
  const clone = new URL(url.href);
  if (clone.password) {
    clone.password = "[redacted]";
  }

  return clone.href;
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
