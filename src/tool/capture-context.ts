import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ConsoleAuthConfig } from "../service/auth.js";
import { assertAllowedRoot } from "../service/path.js";
import type { ConsolePolicy } from "../service/policy.js";
import { getWorkspaceStatus } from "./workspace-status.js";
import { readLatestBuildCommand } from "../service/transcript.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";

export function registerCaptureContextTool(server: McpServer, policy: ConsolePolicy, baseDir: string, authConfig: ConsoleAuthConfig): void {
  server.registerTool(
    "console.capture_context",
    {
      description: "Capture compact workspace context using only approved read-only operations.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
      }).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async ({ workspacePath }) => {
      const context = await captureContext(policy, baseDir, workspacePath);
      return textResult(context);
    }
  );
}

export async function captureContext(policy: ConsolePolicy, baseDir: string, workspacePath: string): Promise<Record<string, unknown>> {
  const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);
  const status = await getWorkspaceStatus(policy, cwd);

  const packageJsonPath = path.join(cwd, "package.json");
  const composerJsonPath = path.join(cwd, "composer.json");

  const packageScripts = await readScriptsIfPresent(packageJsonPath);
  const composerScripts = await readScriptsIfPresent(composerJsonPath);
  const latestBuildCommand = await readLatestBuildCommand(path.join(baseDir, "var", "transcript"));

  return {
    cwd,
    git: status,
    package_scripts: packageScripts,
    composer_scripts: composerScripts,
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
