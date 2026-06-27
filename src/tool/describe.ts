import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsolePolicy } from "../service/policy.js";
import type { ConsoleAuthConfig } from "../service/auth.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";

export function registerDescribeTool(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  server.registerTool(
    "console.describe",
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
      tools: [
        "console.describe",
        "console.health",
        "console.workspace_status",
        "console.capture_context",
        "console.read_file",
        "console.search_text",
        "console.run_check",
        "console.apply_patch",
        "console.google_ads_editor_database_list",
        "console.google_ads_editor_ini_summary",
        "console.sqlite_query_readonly",
        "console.git_diff",
        "console.git_diff_stat",
        "console.git_log_file",
        "console.git_show_file",
        "console.git_grep",
        "console.git_reflog_search",
        "console.git_commit",
        "console.composer_script",
        "console.npm_script",
        "console.localhost",
        "console.local_curl",
        "console.php_lint_file",
        "console.php_lint_changed",
      ],
    })
  );
}
