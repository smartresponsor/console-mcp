import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { readRuntimeCapacity } from "../service/runtime-capacity.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";

export { evaluateRuntimeCapacity, readRuntimeCapacity, runtimeCapacityAllowsHeavyWork, runtimeCapacityAllowsNewWork } from "../service/runtime-capacity.js";

export function registerRuntimeCapacityTool(server: McpServer, projectRoot: string, authConfig: ConsoleAuthConfig): void {
  server.registerTool("console.read_.policy.runtime.capacity", {
    description: "Return a read-only runtime capacity verdict from durable watchdog, resource, and stability state.",
    inputSchema: z.object({}).strict(),
    ...buildConsoleToolRegistration(authConfig),
  }, async () => textResult(readRuntimeCapacity(projectRoot)));
}
