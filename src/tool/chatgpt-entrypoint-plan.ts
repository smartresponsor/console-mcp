import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../service/auth.js";
import { buildChatGptEntrypointPlan } from "../service/chatgpt-entrypoint-preset.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";

const inputSchema = z.object({
  rawPrompt: z.string().min(1).max(6000),
  workspacePath: z.string().min(1).optional(),
  componentName: z.string().min(1).optional(),
  taskPreset: z.enum(["auto", "repo_rc_implementation", "general"]).default("auto"),
  maxAutoIterations: z.number().int().min(1).max(100).default(70),
}).strict();

export function registerChatGptEntrypointPlanTool(server: McpServer, authConfig: ConsoleAuthConfig): void {
  server.registerTool(
    "console.read_.browser.chatgpt.entrypoint.plan",
    {
      description: "Plan an enriched ChatGPT entrypoint run from a short request. Read-only.",
      inputSchema,
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input: z.infer<typeof inputSchema>) => textResult(buildChatGptEntrypointPlan(input))
  );
}
