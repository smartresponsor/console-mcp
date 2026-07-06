import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { listGoogleAdsEditorDatabases, queryGoogleAdsEditorDatabase, summarizeGoogleAdsEditorIni } from "../service/google-ads-editor.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";

export function registerGoogleAdsEditorTools(server: McpServer, authConfig: ConsoleAuthConfig): void {
  server.registerTool(
    "console.read_.ads.google_editor.database.list",
    {
      description: "Discover Google Ads Editor local database files using safe dynamic patterns.",
      inputSchema: z.object({}).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async () => textResult(listGoogleAdsEditorDatabases())
  );
  server.registerTool(
    "console.read_.ads.google_editor.ini.summary",
    {
      description: "Read a safe summary of Google Ads Editor ini metadata.",
      inputSchema: z.object({}).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async () => textResult(summarizeGoogleAdsEditorIni())
  );
  server.registerTool(
    "console.read_.database.sql.sqlite.query",
    {
      description: "Run a guarded read-only database query against a known alias only.",
      inputSchema: z.object({ alias: z.string().min(1), query: z.string().min(1), limit: z.number().int().positive().max(500).optional() }).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async ({ alias, query, limit }) => textResult(await queryGoogleAdsEditorDatabase(alias, query, limit))
  );
}

