import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { readTextFile } from "../Infrastructure/FileSystem/SafeFileSystem.js";
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

