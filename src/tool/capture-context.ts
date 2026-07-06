import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { assertAllowedRoot } from "../Policy/PathGuard.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { getWorkspaceStatus } from "./workspace-status.js";
import { readLatestBuildCommand } from "../Infrastructure/Transcript/TranscriptReader.js";
import { buildCodeMemoryGraphSearchPlan, buildWorkspaceUmbrellaWarning, isWorkspaceUmbrellaRoot, resolveCompactCodeMemoryScope } from "../service/code-memory-scope.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";

export function registerCaptureContextTool(server: McpServer, policy: ConsolePolicy, baseDir: string, authConfig: ConsoleAuthConfig): void {
  server.registerTool(
    "console.read_.repo.context.capture",
    {
      description: "Capture compact workspace context using only approved read-only operations.",
      inputSchema: z.object({ workspacePath: z.string().min(1) }).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async ({ workspacePath }) => textResult(await captureContext(policy, baseDir, workspacePath))
  );
}

export async function captureContext(policy: ConsolePolicy, baseDir: string, workspacePath: string): Promise<Record<string, unknown>> {
  const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);

  if (isWorkspaceUmbrellaRoot(policy, cwd)) {
    return {
      cwd,
      ok: false,
      status: "WORKSPACE_ROOT_IS_UMBRELLA",
      workspace_kind: "umbrella",
      git: null,
      code_memory_scope: buildWorkspaceUmbrellaWarning(policy, cwd),
      code_memory_graph_plan: buildCodeMemoryGraphSearchPlan(policy, cwd, buildWorkspaceUmbrellaWarning(policy, cwd), "search_graph", true),
    };
  }

  const status = await getWorkspaceStatus(policy, cwd);

  const packageJsonPath = path.join(cwd, "package.json");
  const composerJsonPath = path.join(cwd, "composer.json");

  const packageScripts = await readScriptsIfPresent(packageJsonPath);
  const composerScripts = await readScriptsIfPresent(composerJsonPath);
  const codeMemoryScope = await resolveCompactCodeMemoryScope(cwd, composerScripts);
  const codeMemoryGraphPlan = buildCodeMemoryGraphSearchPlan(policy, cwd, codeMemoryScope, "search_graph", true);
  const latestBuildCommand = await readLatestBuildCommand(path.join(baseDir, "var", "transcript"));

  return {
    cwd,
    git: status,
    package_scripts: packageScripts,
    composer_scripts: composerScripts,
    code_memory_scope: codeMemoryScope,
    code_memory_graph_plan: codeMemoryGraphPlan,
    last_build_test_command: latestBuildCommand,
  };
}

async function readScriptsIfPresent(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(filePath, "utf8");
    const parsed = JSON.parse(text) as { scripts?: Record<string, unknown> };
    return parsed.scripts ?? null;
  } catch {
    return null;
  }
}

