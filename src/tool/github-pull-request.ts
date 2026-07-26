import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { assertAllowedRoot } from "../Policy/PathGuard.js";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { runSupervisedCommand, truncateOutput } from "../Infrastructure/Process/SupervisedCommand.js";
import { buildConsoleMutationToolRegistration, textResult } from "./common.js";

const repositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "repositoryFullName must be owner/repo");
const branchSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^(?!-)(?!.*(?:\.\.|@\{|\\|\s|~|\^|:|\?|\*|\[))[A-Za-z0-9._/-]+$/, "branch must be a safe Git ref name");
const titleSchema = z.string().trim().min(1).max(256);
const bodySchema = z.string().max(65536);

export function registerGitHubPullRequestTools(
  server: McpServer,
  policy: ConsolePolicy,
  authConfig: ConsoleAuthConfig,
): void {
  const mutationRegistration = buildConsoleMutationToolRegistration(authConfig);

  server.registerTool(
    "console.write.github.pull_request.create",
    {
      description: "Create a GitHub pull request from an already-pushed branch after explicit confirmation.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        repositoryFullName: repositorySchema,
        head: branchSchema,
        base: branchSchema,
        title: titleSchema,
        body: bodySchema.default(""),
        draft: z.boolean().default(false),
        confirmCreate: z.boolean().default(false),
      }).strict(),
      ...mutationRegistration,
    },
    async ({ workspacePath, repositoryFullName, head, base, title, body, draft, confirmCreate }) => {
      const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);

      if (!confirmCreate) {
        return textResult({
          ok: false,
          status: "CONFIRM_PULL_REQUEST_CREATE_REQUIRED",
          repositoryFullName,
          head,
          base,
          title,
          draft,
          requiresConfirmation: true,
        });
      }

      if (head === base) {
        return textResult({
          ok: false,
          status: "PULL_REQUEST_HEAD_EQUALS_BASE",
          repositoryFullName,
          head,
          base,
        });
      }

      const args = [
        "pr", "create",
        "--repo", repositoryFullName,
        "--head", head,
        "--base", base,
        "--title", title,
        "--body", body,
      ];
      if (draft) {
        args.push("--draft");
      }

      const result = await runSupervisedCommand(cwd, "gh", args, 120000, 4 * 1024 * 1024);
      const stdout = truncateOutput(result.stdout, 30000);
      const stderr = truncateOutput(result.stderr, 30000);
      const pullRequestUrl = extractPullRequestUrl(result.stdout);

      return textResult({
        ok: result.ok && pullRequestUrl !== null,
        status: result.ok
          ? (pullRequestUrl ? "PULL_REQUEST_CREATED" : "PULL_REQUEST_URL_NOT_FOUND")
          : "PULL_REQUEST_CREATE_FAILED",
        repositoryFullName,
        head,
        base,
        title,
        draft,
        command: "gh pr create --repo <repository> --head <head> --base <base> --title <title> --body <body>",
        cwd: result.cwd,
        exitCode: result.exitCode,
        pullRequestUrl,
        stdout: stdout.text,
        stdoutTruncated: stdout.truncated,
        stderr: stderr.text,
        stderrTruncated: stderr.truncated,
      });
    },
  );
}

function extractPullRequestUrl(stdout: string): string | null {
  const match = stdout.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/);
  return match?.[0] ?? null;
}
