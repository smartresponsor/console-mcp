import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../service/auth.js";
import type { ConsolePolicy } from "../service/policy.js";
import { searchText } from "../service/fs.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";

export function registerSearchTextTool(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  server.registerTool(
    "console.search_text",
    {
      description: "Search text under an allowed root while skipping generated and dependency trees.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        query: z.string().min(1),
        maxResults: z.number().int().positive().max(200).optional(),
      }).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async ({ workspacePath, query, maxResults }) => textResult(await searchText(policy, workspacePath, query, maxResults ?? policy.maxSearchResults))
  );

  server.registerTool(
    "console.read_.repo.text.search",
    {
      description: "Canonical alias for console.search_text. Search text under an allowed root while skipping generated and dependency trees.",
      inputSchema: z.object({ workspacePath: z.string().min(1), query: z.string().min(1), maxResults: z.number().int().positive().max(200).optional() }).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async ({ workspacePath, query, maxResults }) => textResult(await searchText(policy, workspacePath, query, maxResults ?? policy.maxSearchResults))
  );
}
