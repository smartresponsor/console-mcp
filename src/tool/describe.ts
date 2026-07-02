import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsolePolicy } from "../service/policy.js";
import type { ConsoleAuthConfig } from "../service/auth.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";
import { consoleToolNames } from "./catalog.js";

export function registerDescribeTool(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  server.registerTool(
    "console.read_.system.console.describe",
    {
      description: "Return server identity, transport, workspace root, and the available tools.",
      inputSchema: z.object({}).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async () => textResult({
      server_name: policy.serverName,
      version: policy.version,
      transport: policy.transport,
      endpoint: policy.endpoint,
      workspace_root: policy.workspaceRoot,
      tools: [...consoleToolNames],
    })
  );
}
