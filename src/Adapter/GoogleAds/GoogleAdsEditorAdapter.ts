import { existsSync, readdirSync, statSync, openSync, readSync, closeSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import initSqlJs from "sql.js";

let sqlModulePromise: ReturnType<typeof initSqlJs> | null = null;

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "utf8");
const ACCOUNT_DB = /^ape_(\d+)\.db$/;
const STATS_DB = /^ape_stats_(\d+)\.db$/;
const UNDO_DB = /^ape_undo_(\d+)\.db$/;

export type GoogleAdsEditorDatabase = {
  alias: string;
  version: string | null;
  kind: "main" | "account" | "stats" | "undo" | "link_check" | "assets";
  accountId: string | null;
  size: number;
  lastWriteTime: string;
  path: string;
};

export type GoogleAdsEditorDatabaseList = {
  ok: true;
  root: string;
  iniPath: string;
  versions: string[];
  latestVersion: string | null;
  databases: GoogleAdsEditorDatabase[];
};

export function listGoogleAdsEditorDatabases(): GoogleAdsEditorDatabaseList {
  const root = getGoogleAdsEditorRoot();
  const iniPath = getGoogleAdsEditorIniPath();
  const versions = listVersionDirectories(root);
  const databases: GoogleAdsEditorDatabase[] = [];

  for (const version of versions) {
    const versionRoot = path.join(root, version);
    addDatabase(databases, root, {
      alias: `google_ads_editor.${version}.main`,
      version,
      kind: "main",
      accountId: null,
      filePath: path.join(versionRoot, "ape.db"),
    });
    addDatabase(databases, root, {
      alias: `google_ads_editor.${version}.link_check`,
      version,
      kind: "link_check",
      accountId: null,
      filePath: path.join(versionRoot, "ape_link_check.db"),
    });

    if (!existsSync(versionRoot)) {
      continue;
    }

    for (const item of readdirSync(versionRoot, { withFileTypes: true })) {
      if (!item.isFile()) {
        continue;
      }

      const account = item.name.match(ACCOUNT_DB);
      if (account) {
        addDatabase(databases, root, {
          alias: `google_ads_editor.${version}.account.${account[1]}`,
          version,
          kind: "account",
          accountId: account[1],
          filePath: path.join(versionRoot, item.name),
        });
        continue;
      }

      const stats = item.name.match(STATS_DB);
      if (stats) {
        addDatabase(databases, root, {
          alias: `google_ads_editor.${version}.stats.${stats[1]}`,
          version,
          kind: "stats",
          accountId: stats[1],
          filePath: path.join(versionRoot, item.name),
        });
        continue;
      }

      const undo = item.name.match(UNDO_DB);
      if (undo) {
        addDatabase(databases, root, {
          alias: `google_ads_editor.${version}.undo.${undo[1]}`,
          version,
          kind: "undo",
          accountId: undo[1],
          filePath: path.join(versionRoot, item.name),
        });
      }
    }
  }

  addDatabase(databases, root, {
    alias: "google_ads_editor.assets",
    version: null,
    kind: "assets",
    accountId: null,
    filePath: path.join(root, "Assets", "assets.db"),
  });

  const latestVersion = chooseLatestVersion(databases);
  const latestAliases = latestVersion
    ? databases.filter((item) => item.version === latestVersion && item.kind !== "undo").map(toLatestAlias)
    : [];

  return {
    ok: true,
    root,
    iniPath,
    versions,
    latestVersion,
    databases: [...databases, ...latestAliases].sort((a, b) => a.alias.localeCompare(b.alias)),
  };
}

export function summarizeGoogleAdsEditorIni(): Record<string, unknown> {
  const iniPath = getGoogleAdsEditorIniPath();
  if (!existsSync(iniPath)) {
    return { ok: true, exists: false, path: iniPath, safeHints: [] };
  }

  const stat = statSync(iniPath);
  const lines = readFileSync(iniPath, "utf8").split(/\r?\n/);
  const safeHints = lines
    .filter((line) => /account|customer|version|recent|last/i.test(line))
    .filter((line) => !/token|secret|password|cookie|credential|oauth|refresh/i.test(line))
    .slice(0, 200)
    .map((line) => line.replace(/=(.{8}).+$/u, "=$1…[redacted]"));

  return { ok: true, exists: true, path: iniPath, size: stat.size, lastWriteTime: stat.mtime.toISOString(), safeHints };
}

export function getGoogleAdsEditorRoot(): string {
  return path.resolve(process.env.CONSOLE_MCP_GOOGLE_ADS_EDITOR_ROOT || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Google", "Google-AdWords-Editor"));
}

export function getGoogleAdsEditorIniPath(): string {
  return path.resolve(process.env.CONSOLE_MCP_GOOGLE_ADS_EDITOR_INI || path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Google", "Google-AdWords-Editor.ini"));
}

function listVersionDirectories(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  return readdirSync(root, { withFileTypes: true }).filter((item) => item.isDirectory() && /^\d+$/.test(item.name)).map((item) => item.name).sort((a, b) => Number(a) - Number(b));
}

function addDatabase(items: GoogleAdsEditorDatabase[], root: string, input: Omit<GoogleAdsEditorDatabase, "size" | "lastWriteTime" | "path"> & { filePath: string }): void {
  const filePath = path.resolve(input.filePath);
  if (!isInsideRoot(filePath, root) || !existsSync(filePath) || !hasSQLiteHeader(filePath)) {
    return;
  }

  const stat = statSync(filePath);
  items.push({ alias: input.alias, version: input.version, kind: input.kind, accountId: input.accountId, size: stat.size, lastWriteTime: stat.mtime.toISOString(), path: filePath });
}

function hasSQLiteHeader(filePath: string): boolean {
  const stat = statSync(filePath);
  if (!stat.isFile() || stat.size <= SQLITE_HEADER.length) {
    return false;
  }

  const fd = openSync(filePath, "r");
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    readSync(fd, header, 0, header.length, 0);
    return header.equals(SQLITE_HEADER);
  } finally {
    closeSync(fd);
  }
}

function isInsideRoot(filePath: string, root: string): boolean {
  const relative = path.relative(root, filePath);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function chooseLatestVersion(items: GoogleAdsEditorDatabase[]): string | null {
  return items.filter((item) => item.version && item.kind === "account").sort((a, b) => b.lastWriteTime.localeCompare(a.lastWriteTime))[0]?.version || null;
}

function toLatestAlias(item: GoogleAdsEditorDatabase): GoogleAdsEditorDatabase {
  const suffix = item.accountId ? `${item.kind}.${item.accountId}` : item.kind;
  return { ...item, alias: `google_ads_editor.latest.${suffix}` };
}

export async function queryGoogleAdsEditorDatabase(alias: string, query: string, limit = 200): Promise<Record<string, unknown>> {
  const database = resolveGoogleAdsEditorDatabase(alias);
  const maxRows = Math.max(1, Math.min(Number(limit || 200), 500));
  const maxBytes = Number(process.env.CONSOLE_MCP_SQLITE_MAX_BYTES || 524288);
  const safeQuery = withRowLimit(validateReadOnlyQuery(query), maxRows);
  const SQL = await loadSqlModule();
  const bytes = readFileSync(database.path);
  const db = new SQL.Database(bytes);

  try {
    const result = db.exec(safeQuery);
    const first = result[0] || { columns: [], values: [] };
    const rows = first.values.slice(0, maxRows).map((values: unknown[]) => rowFromColumns(first.columns, values));
    const payload = { ok: true, database, query: safeQuery, columns: first.columns, rows, rowCount: rows.length, maxRows };
    const size = Buffer.byteLength(JSON.stringify(payload), "utf8");
    if (size > maxBytes) {
      return { ok: true, database, query: safeQuery, columns: first.columns, rows: [], rowCount: 0, maxRows, maxBytes, bytes: size, bytesTruncated: true };
    }

    return { ...payload, maxBytes, bytes: size, bytesTruncated: false };
  } finally {
    db.close();
  }
}

function resolveGoogleAdsEditorDatabase(alias: string): GoogleAdsEditorDatabase {
  const normalized = String(alias || "").trim();
  if (!normalized || normalized.includes("/") || normalized.includes("\\") || normalized.includes("..")) {
    throw new Error("Database alias is required and must not be a path.");
  }

  const database = listGoogleAdsEditorDatabases().databases.find((item) => item.alias === normalized);
  if (!database) {
    throw new Error(`Unknown Google Ads Editor database alias: ${normalized}`);
  }

  return database;
}

function validateReadOnlyQuery(query: string): string {
  const normalized = String(query || "").trim().replace(/\s+/g, " ");
  const statement = normalized.endsWith(";") ? normalized.slice(0, -1).trim() : normalized;
  if (!statement || statement.includes(";")) {
    throw new Error("Exactly one SQL statement is required.");
  }

  if (!/^(select|pragma)\b/i.test(statement)) {
    throw new Error("Only SELECT or PRAGMA statements are allowed.");
  }

  if (/\b(attach|detach|insert|update|delete|alter|drop|create|replace|vacuum|reindex)\b/i.test(statement)) {
    throw new Error("Blocked SQL keyword.");
  }

  if (/^pragma\b/i.test(statement) && !/^pragma\s+(table_info|index_list|index_info|foreign_key_list)\s*\(/i.test(statement)) {
    throw new Error("Only safe schema PRAGMA calls are allowed.");
  }

  return statement;
}

function withRowLimit(query: string, limit: number): string {
  return /^select\b/i.test(query) && !/\blimit\s+\d+\b/i.test(query) ? `${query} LIMIT ${limit}` : query;
}

async function loadSqlModule(): Promise<Awaited<ReturnType<typeof initSqlJs>>> {
  sqlModulePromise ??= initSqlJs();
  return sqlModulePromise;
}

function rowFromColumns(columns: string[], values: unknown[]): Record<string, unknown> {
  return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
}
