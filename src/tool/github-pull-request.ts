import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { assertAllowedRoot } from "../Policy/PathGuard.js";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { runSupervisedCommand, truncateOutput } from "../Infrastructure/Process/SupervisedCommand.js";
import { buildConsoleMutationToolRegistration, buildConsoleToolRegistration, textResult } from "./common.js";

const repositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "repositoryFullName must be owner/repo");
const branchSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^(?!-)(?!.*(?:\.\.|@\{|\\|\s|~|\^|:|\?|\*|\[))[A-Za-z0-9._/-]+$/, "branch must be a safe Git ref name");
const titleSchema = z.string().trim().min(1).max(256);
const bodySchema = z.string().max(65536);
const pullRequestNumberSchema = z.number().int().positive();
const mergeMethodSchema = z.enum(["squash", "merge", "rebase"]);

type PullRequestSnapshot = {
  number: number;
  state: string;
  isDraft: boolean;
  mergeable: string;
  reviewDecision: string | null;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  title: string;
  url: string;
  statusCheckRollup: unknown[];
};

export function registerGitHubPullRequestTools(
  server: McpServer,
  policy: ConsolePolicy,
  authConfig: ConsoleAuthConfig,
): void {
  const registration = buildConsoleToolRegistration(authConfig);
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

  server.registerTool(
    "console.read_.github.pull_request.inspect",
    {
      description: "Inspect a GitHub pull request and evaluate the default safe-merge gate without mutating remote state.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        repositoryFullName: repositorySchema,
        pullRequestNumber: pullRequestNumberSchema,
      }).strict(),
      ...registration,
    },
    async ({ workspacePath, repositoryFullName, pullRequestNumber }) => {
      const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);
      const snapshot = await readPullRequestSnapshot(cwd, repositoryFullName, pullRequestNumber);
      if (!snapshot.ok) return textResult(snapshot);

      return textResult({
        ok: true,
        status: "PULL_REQUEST_INSPECTED",
        repositoryFullName,
        pullRequest: snapshot.pullRequest,
        mergeGate: evaluateMergeGate(snapshot.pullRequest),
      });
    },
  );

  server.registerTool(
    "console.write.github.pull_request.merge",
    {
      description: "Safely merge a GitHub pull request only when the merge gate passes and the inspected head SHA remains unchanged.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        repositoryFullName: repositorySchema,
        pullRequestNumber: pullRequestNumberSchema,
        method: mergeMethodSchema.default("squash"),
        confirmMerge: z.boolean().default(false),
      }).strict(),
      ...mutationRegistration,
    },
    async ({ workspacePath, repositoryFullName, pullRequestNumber, method, confirmMerge }) => {
      const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);
      if (!confirmMerge) {
        return textResult({
          ok: false,
          status: "CONFIRM_PULL_REQUEST_MERGE_REQUIRED",
          repositoryFullName,
          pullRequestNumber,
          method,
          requiresConfirmation: true,
        });
      }

      const before = await readPullRequestSnapshot(cwd, repositoryFullName, pullRequestNumber);
      if (!before.ok) return textResult(before);

      const mergeGate = evaluateMergeGate(before.pullRequest);
      if (!mergeGate.allowed) {
        return textResult({
          ok: false,
          status: "PULL_REQUEST_MERGE_BLOCKED",
          repositoryFullName,
          pullRequest: before.pullRequest,
          mergeGate,
        });
      }

      const args = [
        "pr", "merge", String(pullRequestNumber),
        "--repo", repositoryFullName,
        `--${method}`,
        "--match-head-commit", before.pullRequest.headRefOid,
      ];
      const result = await runSupervisedCommand(cwd, "gh", args, 120000, 4 * 1024 * 1024);
      const stdout = truncateOutput(result.stdout, 30000);
      const stderr = truncateOutput(result.stderr, 30000);
      const after = await readPullRequestSnapshot(cwd, repositoryFullName, pullRequestNumber);
      const merged = after.ok && after.pullRequest.state === "MERGED";

      return textResult({
        ok: result.ok && merged,
        status: result.ok ? (merged ? "PULL_REQUEST_MERGED" : "PULL_REQUEST_MERGE_NOT_VERIFIED") : "PULL_REQUEST_MERGE_FAILED",
        repositoryFullName,
        pullRequestNumber,
        method,
        inspectedHeadSha: before.pullRequest.headRefOid,
        mergeGate,
        command: `gh pr merge <number> --repo <repository> --${method} --match-head-commit <sha>`,
        exitCode: result.exitCode,
        stdout: stdout.text,
        stdoutTruncated: stdout.truncated,
        stderr: stderr.text,
        stderrTruncated: stderr.truncated,
        pullRequest: after.ok ? after.pullRequest : null,
        verificationError: after.ok ? null : after,
      });
    },
  );

  server.registerTool(
    "console.write.github.pull_request.close",
    {
      description: "Close an existing GitHub pull request without merging or deleting its branch after explicit confirmation.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        repositoryFullName: repositorySchema,
        pullRequestNumber: pullRequestNumberSchema,
        comment: z.string().trim().max(2000).optional(),
        confirmClose: z.boolean().default(false),
      }).strict(),
      ...mutationRegistration,
    },
    async ({ workspacePath, repositoryFullName, pullRequestNumber, comment, confirmClose }) => {
      const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);
      if (!confirmClose) {
        return textResult({
          ok: false,
          status: "CONFIRM_PULL_REQUEST_CLOSE_REQUIRED",
          repositoryFullName,
          pullRequestNumber,
          requiresConfirmation: true,
        });
      }

      const before = await readPullRequestSnapshot(cwd, repositoryFullName, pullRequestNumber);
      if (!before.ok) return textResult(before);
      if (before.pullRequest.state !== "OPEN") {
        return textResult({
          ok: before.pullRequest.state === "CLOSED",
          status: before.pullRequest.state === "CLOSED" ? "PULL_REQUEST_ALREADY_CLOSED" : "PULL_REQUEST_CLOSE_BLOCKED",
          repositoryFullName,
          pullRequest: before.pullRequest,
        });
      }

      const args = ["pr", "close", String(pullRequestNumber), "--repo", repositoryFullName];
      if (comment) args.push("--comment", comment);
      const result = await runSupervisedCommand(cwd, "gh", args, 120000, 4 * 1024 * 1024);
      const stdout = truncateOutput(result.stdout, 30000);
      const stderr = truncateOutput(result.stderr, 30000);
      const after = await readPullRequestSnapshot(cwd, repositoryFullName, pullRequestNumber);
      const closed = after.ok && after.pullRequest.state === "CLOSED";

      return textResult({
        ok: result.ok && closed,
        status: result.ok ? (closed ? "PULL_REQUEST_CLOSED" : "PULL_REQUEST_CLOSE_NOT_VERIFIED") : "PULL_REQUEST_CLOSE_FAILED",
        repositoryFullName,
        pullRequestNumber,
        command: "gh pr close <number> --repo <repository>",
        exitCode: result.exitCode,
        stdout: stdout.text,
        stdoutTruncated: stdout.truncated,
        stderr: stderr.text,
        stderrTruncated: stderr.truncated,
        pullRequest: after.ok ? after.pullRequest : null,
        verificationError: after.ok ? null : after,
      });
    },
  );
}

async function readPullRequestSnapshot(
  cwd: string,
  repositoryFullName: string,
  pullRequestNumber: number,
): Promise<{ ok: true; pullRequest: PullRequestSnapshot } | { ok: false; [key: string]: unknown }> {
  const fields = "number,state,isDraft,mergeable,reviewDecision,headRefOid,headRefName,baseRefName,title,url,statusCheckRollup";
  const result = await runSupervisedCommand(
    cwd,
    "gh",
    ["pr", "view", String(pullRequestNumber), "--repo", repositoryFullName, "--json", fields],
    120000,
    4 * 1024 * 1024,
  );
  const stdout = truncateOutput(result.stdout, 30000);
  const stderr = truncateOutput(result.stderr, 30000);
  if (!result.ok) {
    return {
      ok: false,
      status: "PULL_REQUEST_INSPECT_FAILED",
      repositoryFullName,
      pullRequestNumber,
      exitCode: result.exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
    };
  }

  try {
    return { ok: true, pullRequest: JSON.parse(result.stdout) as PullRequestSnapshot };
  } catch {
    return {
      ok: false,
      status: "PULL_REQUEST_INSPECT_OUTPUT_PARSE_FAILED",
      repositoryFullName,
      pullRequestNumber,
      stdout: stdout.text,
      stderr: stderr.text,
    };
  }
}

function evaluateMergeGate(pullRequest: PullRequestSnapshot): { allowed: boolean; blockers: string[]; checkSummary: Record<string, number> } {
  const blockers: string[] = [];
  if (pullRequest.state !== "OPEN") blockers.push(`state:${pullRequest.state}`);
  if (pullRequest.isDraft) blockers.push("draft");
  if (pullRequest.mergeable !== "MERGEABLE") blockers.push(`mergeable:${pullRequest.mergeable}`);
  if (pullRequest.reviewDecision === "CHANGES_REQUESTED") blockers.push("review:changes-requested");

  const checkSummary = { successful: 0, pending: 0, failed: 0, unknown: 0 };
  for (const check of pullRequest.statusCheckRollup ?? []) {
    if (!isRecord(check)) {
      checkSummary.unknown++;
      continue;
    }
    const state = typeof check.state === "string" ? check.state : null;
    const conclusion = typeof check.conclusion === "string" ? check.conclusion : null;
    const status = typeof check.status === "string" ? check.status : null;
    const value = (conclusion ?? state ?? status ?? "UNKNOWN").toUpperCase();
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(value)) checkSummary.successful++;
    else if (["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"].includes(value)) checkSummary.pending++;
    else if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STALE", "STARTUP_FAILURE"].includes(value)) checkSummary.failed++;
    else checkSummary.unknown++;
  }
  if (checkSummary.pending > 0) blockers.push(`checks:pending:${checkSummary.pending}`);
  if (checkSummary.failed > 0) blockers.push(`checks:failed:${checkSummary.failed}`);
  if (checkSummary.unknown > 0) blockers.push(`checks:unknown:${checkSummary.unknown}`);

  return { allowed: blockers.length === 0, blockers, checkSummary };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractPullRequestUrl(stdout: string): string | null {
  const match = stdout.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/);
  return match?.[0] ?? null;
}
