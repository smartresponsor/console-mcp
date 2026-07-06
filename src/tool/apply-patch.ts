import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { applyUnifiedDiffPatch } from "../Infrastructure/Patch/UnifiedDiffPatch.js";
import { buildConsoleMutationToolRegistration, textResult } from "./common.js";

export function registerApplyPatchTool(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  server.registerTool(
    "console.write.repo.patch.apply",
    {
      description: "Apply a unified diff patch to a workspace under an allowed root after explicit user approval.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        patch: z.string().min(1),
        dryRun: z.boolean().optional(),
        expectedChangedFiles: z.array(z.string().min(1)).max(20).optional(),
        reason: z.string().min(1).max(1000).optional(),
      }).strict(),
      ...buildConsoleMutationToolRegistration(authConfig),
    },
    async ({ workspacePath, patch, dryRun, expectedChangedFiles, reason }) => {
      const result = await applyUnifiedDiffPatch(policy, {
        workspacePath,
        patch,
        dryRun,
        expectedChangedFiles,
        reason,
      });

      if (result.ok) {
        return textResult(result);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
        isError: true,
      };
    }
  );
}


