import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { registerCacheMaintenanceTools } from "./cache-maintenance.js";
import { registerNpmInstallTool } from "./npm-install.js";

export function registerRuntimeMaintenanceTools(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  registerCacheMaintenanceTools(server, policy, authConfig);
  registerNpmInstallTool(server, policy, authConfig);
}
