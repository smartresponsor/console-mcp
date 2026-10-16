import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { listGoogleAdsEditorDatabases, summarizeGoogleAdsEditorIni } from "../service/google-ads-editor.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";
import { registerLegacyGoogleAdsSqliteAliasResolver } from "../service/google-ads-sqlite-alias.js";

export function registerGoogleAdsEditorTools(server: McpServer, authConfig: ConsoleAuthConfig): void {
  registerLegacyGoogleAdsSqliteAliasResolver((alias) => {
    const database = listGoogleAdsEditorDatabases().databases.find((item) => item.alias === alias);
    if (!database) throw new Error(`Unknown Google Ads Editor database alias: ${alias}`);
    return database.path;
  });
  server.registerTool(
    "read_.ads.google.editor.database.list",
    {
      description: "Discover Google Ads Editor local database files using safe dynamic patterns.",
      inputSchema: z.object({}).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async () => textResult(listGoogleAdsEditorDatabases())
  );
  server.registerTool(
    "read_.ads.google.editor.ini.summary",
    {
      description: "Read a safe summary of Google Ads Editor ini metadata.",
      inputSchema: z.object({}).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async () => textResult(summarizeGoogleAdsEditorIni())
  );
}

