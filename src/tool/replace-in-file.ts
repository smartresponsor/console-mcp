import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { replaceTextInFile } from "../Infrastructure/FileSystem/FileEdit.js";
import { replaceViaRepositoryWriteSocket } from "../Infrastructure/Process/RepositoryWriteClient.js";
import { buildConsoleMutationToolRegistration, textResult } from "./common.js";

export function registerReplaceInFileTool(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  server.registerTool(
    "write.repo.file.replace.text",
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
    async (input) => {
      const socketPath = process.env.CONSOLE_MCP_REPO_WRITE_SOCKET?.trim();
      if (!socketPath && process.env.CONSOLE_MCP_MANAGED_RUNTIME === "systemd") {
        throw new Error("Repository write worker is not configured; mutation refused");
      }
      const result = socketPath
        ? await replaceViaRepositoryWriteSocket(socketPath, input)
        : await replaceTextInFile(policy, input);
      return textResult(result);
    }
  );
}

