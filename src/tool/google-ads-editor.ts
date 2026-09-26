import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { listGoogleAdsEditorDatabases, summarizeGoogleAdsEditorIni } from "../service/google-ads-editor.js";
import { buildConsoleToolRegistration, registerConsoleToolWithLegacyAlias, textResult } from "./common.js";

export function registerGoogleAdsEditorTools(server: McpServer, authConfig: ConsoleAuthConfig): void {
  registerConsoleToolWithLegacyAlias(
    server,
    "console.read_.ads.google.editor.database.list",
    "console.read_.ads.google_editor.database.list",
    {
      description: "Discover Google Ads Editor local database files using safe dynamic patterns.",
      inputSchema: z.object({}).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async () => textResult(listGoogleAdsEditorDatabases())
  );
  registerConsoleToolWithLegacyAlias(
    server,
    "console.read_.ads.google.editor.ini.summary",
    "console.read_.ads.google_editor.ini.summary",
    {
      description: "Read a safe summary of Google Ads Editor ini metadata.",
      inputSchema: z.object({}).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async () => textResult(summarizeGoogleAdsEditorIni())
  );
}

