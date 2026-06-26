import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../service/auth.js";
import { listGoogleAdsEditorDatabases, queryGoogleAdsEditorDatabase, summarizeGoogleAdsEditorIni } from "../service/google-ads-editor.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";

export function registerGoogleAdsEditorTools(server: McpServer, authConfig: ConsoleAuthConfig): void {
  server.registerTool(
    "console.google_ads_editor_database_list",
    {
      description: "Discover Google Ads Editor local database files using safe dynamic patterns.",
      inputSchema: z.object({}).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async () => textResult(listGoogleAdsEditorDatabases())
  );
  server.registerTool(
    "console.google_ads_editor_ini_summary",
    {
      description: "Read a safe summary of Google Ads Editor ini metadata.",
      inputSchema: z.object({}).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async () => textResult(summarizeGoogleAdsEditorIni())
  );
  server.registerTool(
    "console.sqlite_query_readonly",
    {
      description: "Run a guarded read-only SQLite query against a known database alias only.",
      inputSchema: z.object({
        alias: z.string().min(1),
        query: z.string().min(1),
        limit: z.number().int().positive().max(500).optional(),
      }).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async ({ alias, query, limit }) => textResult(await queryGoogleAdsEditorDatabase(alias, query, limit))
  );
}
