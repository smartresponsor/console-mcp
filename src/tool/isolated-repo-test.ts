import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "node:path";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { assertAllowedRoot } from "../Policy/PathGuard.js";
import { runSupervisedCommand } from "../Infrastructure/Process/SupervisedCommand.js";
import { startRepositoryWorkerCommand } from "../Infrastructure/Process/RepositoryWorkerHost.js";
import { resolveRepositoryScopeWithBinding } from "../service/repository-binding.js";
import { buildConsoleMutationToolRegistration, textResult } from "./common.js";
import { assertApprovedIsolatedTestSha } from "./isolated-test-approval.js";

const shaPattern = /^[a-f0-9]{40}$/;
export const isolatedTestProfile = "mcp-http-efficiency" as const;

/**
 * Fixed, bounded acceptance profile. Not a general-purpose command runner.
 * The mutable repository checkout is never built or switched.
 */
export function registerIsolatedRepoTestTool(server: McpServer, policy: ConsolePolicy, projectRoot: string, authConfig: ConsoleAuthConfig): void {
  server.registerTool("write.repo.test.isolated", {
    description: "Start the fixed MCP efficiency build and HTTP acceptance suite on a pinned, remote-tracking Git commit in a disposable worktree; no production checkout change. Read result using read_.repo.command.status/output.",
    inputSchema: z.object({
      workspacePath: z.string().min(1),
      sha: z.string().regex(shaPattern),
      profile: z.literal(isolatedTestProfile).default(isolatedTestProfile),
      confirmRun: z.boolean().default(false),
    }).strict(),
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async ({ workspacePath, sha, profile, confirmRun }) => {
    const workspace = assertAllowedRoot(workspacePath, policy.allowedRoots);
    try { assertApprovedIsolatedTestSha(sha); }
    catch { return textResult({ ok: false, status: "ISOLATED_TEST_SHA_NOT_APPROVED", sha }); }
    if (!confirmRun) return textResult({
      ok: false, status: "ISOLATED_TEST_CONFIRMATION_REQUIRED",
      requires: { workspacePath: workspace, sha, profile, confirmRun: true },
    });

    const type = await runSupervisedCommand(workspace, "git", ["cat-file", "-t", sha], 15_000);
    if (!type.ok || type.stdout.trim() !== "commit") {
      return textResult({ ok: false, status: "ISOLATED_TEST_SHA_NOT_LOCAL_COMMIT", sha });
    }
    // Never execute an arbitrary local/dirty commit: pin to a fetched remote-tracking ref.
    const contains = await runSupervisedCommand(workspace, "git", ["branch", "-r", "--contains", sha], 20_000);
    if (!contains.ok || !contains.stdout.split(/\r?\n/).some(line => /^\s*origin\/(?!HEAD\b)[^\s]+$/.test(line))) {
      return textResult({ ok: false, status: "ISOLATED_TEST_SHA_NOT_REMOTE_TRACKED", sha });
    }
    const scope = await resolveRepositoryScopeWithBinding(policy, { workspacePath: workspace });
    const runner = path.join(projectRoot, "dist", "tool", "isolated-repo-test-worker.js");
    return textResult({
      profile, sha,
      ...(await startRepositoryWorkerCommand(scope, {
        workspacePath: workspace,
        command: process.execPath,
        args: [runner, sha],
        timeoutMs: 600_000,
        kind: "isolated-test:mcp-http-efficiency",
      })),
    });
  });
}
