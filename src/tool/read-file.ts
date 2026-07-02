import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../service/auth.js";
import type { ConsolePolicy } from "../service/policy.js";
import { readTextFile } from "../service/fs.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";

export function registerReadFileTool(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  server.registerTool(
    "console.read_.repo.file.read",
    {
      description: "Read a file only when it is inside the allowed root and not denied by policy.",
      inputSchema: z.object({ filePath: z.string().min(1) }).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async ({ filePath }) => textResult(await readTextFile(policy, filePath))
  );
}
