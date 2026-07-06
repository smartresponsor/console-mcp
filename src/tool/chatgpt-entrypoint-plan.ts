import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { assertAllowedRoot } from "../Policy/PathGuard.js";
import { buildChatGptEntrypointPlan } from "../service/chatgpt-entrypoint-preset.js";
import { buildCodeMemoryGraphSearchPlan, buildWorkspaceUmbrellaWarning, isWorkspaceUmbrellaRoot, resolveCompactCodeMemoryScope } from "../service/code-memory-scope.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";

const inputSchema = z.object({
  rawPrompt: z.string().min(1).max(6000),
  workspacePath: z.string().min(1).optional(),
  componentName: z.string().min(1).optional(),
  taskPreset: z.enum(["auto", "repo_rc_implementation", "general"]).default("auto"),
  maxAutoIterations: z.number().int().min(1).max(100).default(70),
}).strict();

export function registerChatGptEntrypointPlanTool(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  server.registerTool(
    "console.read_.browser.chatgpt.entrypoint.plan",
    {
      description: "Plan an enriched ChatGPT entrypoint run from a short request. Read-only.",
      inputSchema,
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input: z.infer<typeof inputSchema>) => textResult(await buildScopedEntrypointPlan(policy, input))
  );
}

async function buildScopedEntrypointPlan(policy: ConsolePolicy, input: z.infer<typeof inputSchema>): Promise<Record<string, unknown>> {
  const plan = buildChatGptEntrypointPlan(input);
  const workspacePath = typeof plan.workspacePath === "string" && plan.workspacePath.length > 0 ? plan.workspacePath : null;
  if (workspacePath === null) {
    return {
      ...plan,
      scope_preflight: {
        ok: true,
        status: "CODE_MEMORY_SCOPE_WORKSPACE_NOT_PROVIDED",
        requiredBeforeImplementation: true,
      },
    };
  }

  const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);
  const codeMemoryScope = isWorkspaceUmbrellaRoot(policy, cwd)
    ? buildWorkspaceUmbrellaWarning(policy, cwd)
    : await resolveCompactCodeMemoryScope(cwd);

  const codeMemoryGraphPlan = buildCodeMemoryGraphSearchPlan(policy, cwd, codeMemoryScope, "search_graph", true);

  return {
    ...plan,
    workspacePath: cwd,
    scope_preflight: {
      ok: codeMemoryScope.status !== "WORKSPACE_ROOT_IS_UMBRELLA",
      status: codeMemoryScope.status,
      activeProjectRequired: codeMemoryScope.status === "WORKSPACE_ROOT_IS_UMBRELLA",
      requiredBeforeImplementation: true,
      rawUnscopedWorkspaceRootAllowed: false,
    },
    code_memory_scope: codeMemoryScope,
    code_memory_graph_plan: codeMemoryGraphPlan,
  };
}

