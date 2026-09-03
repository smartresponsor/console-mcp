import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { registerQaTools as registerCoreQaTools } from "./qa-core.js";
import { registerNpmInstallTool } from "./npm-install.js";

export function registerQaTools(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  registerCoreQaTools(server, policy, authConfig);
  registerNpmInstallTool(server, policy, authConfig);
}
