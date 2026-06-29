import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../service/auth.js";
import type { ConsolePolicy } from "../service/policy.js";
import { replaceTextInFile } from "../service/file-edit.js";
import { buildConsoleMutationToolRegistration, textResult } from "./common.js";

export function registerReplaceInFileTool(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  server.registerTool(
    "console.replace_in_file",
    {
      description: "Replace exact text in a workspace file with a dry-run option and workspace-root protection.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        filePath: z.string().min(1),
        search: z.string().min(1),
        replace: z.string(),
        expectedOccurrences: z.number().int().positive().optional(),
        dryRun: z.boolean().optional(),
        reason: z.string().min(1).max(1000).optional(),
      }).strict(),
      ...buildConsoleMutationToolRegistration(authConfig),
    },
    async (input) => textResult(await replaceTextInFile(policy, input))
  );
}
