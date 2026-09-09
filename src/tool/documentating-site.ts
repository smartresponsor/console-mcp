import { existsSync, statSync } from "node:fs";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runSupervisedCommand, truncateOutput } from "../Infrastructure/Process/SupervisedCommand.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { assertAllowedRoot } from "../Policy/PathGuard.js";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { buildConsoleMutationToolRegistration, textResult } from "./common.js";

const BUILD_SCRIPT = "tools/build_site.ps1";
const SITE_DIR = ".site_build";
const REMOTE = "origin";
const TARGET_BRANCH = "gh-pages";
const OUTPUT_LIMIT = 24000;

export function registerDocumentatingSiteTools(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  const registration = buildConsoleMutationToolRegistration(authConfig);
  server.registerTool("console.write.repo.documentating.site.build", {
    ...registration,
    description: "Run the canonical local Documentating Antora build without installing dependencies, then verify generated output.",
    inputSchema: z.object({ workspacePath: z.string().min(1), expectedTitle: z.string().min(1).max(500).optional(), confirmBuild: z.boolean().default(false) }).strict(),
  }, async ({ workspacePath, expectedTitle, confirmBuild }) => textResult(await buildSite(policy, workspacePath, expectedTitle, Boolean(confirmBuild))));
  server.registerTool("console.write.repo.documentating.site.publish", {
    ...registration,
    description: "Publish an existing Documentating .site_build to origin/gh-pages in an isolated temporary worktree while preserving the current worktree.",
    inputSchema: z.object({ workspacePath: z.string().min(1), commitMessage: z.string().min(1).max(200).default("docs: publish canonical Antora site"), confirmPublish: z.boolean().default(false) }).strict(),
  }, async ({ workspacePath, commitMessage, confirmPublish }) => textResult(await publishSite(policy, workspacePath, commitMessage, Boolean(confirmPublish))));
}

async function buildSite(policy: ConsolePolicy, workspacePath: string, expectedTitle: string | undefined, confirmBuild: boolean): Promise<Record<string, unknown>> {
  const cwd = resolveDocumentatingWorkspace(policy, workspacePath);
  if (!confirmBuild) return { ok: false, status: "CONFIRM_DOCUMENTATING_BUILD_REQUIRED", cwd, requires: { workspacePath: cwd, expectedTitle, confirmBuild: true } };
  const script = path.join(cwd, ...BUILD_SCRIPT.split("/"));
  const result = await runSupervisedCommand(cwd, "pwsh", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], 1800000, 4 * 1024 * 1024);
  const siteDir = path.join(cwd, SITE_DIR);
  const titlePath = expectedTitle ? await findHtmlContaining(siteDir, expectedTitle) : null;
  const verified = result.ok && isDirectory(path.join(cwd, ".antora-src")) && isGeneratedSite(siteDir) && (!expectedTitle || titlePath !== null);
  return { ok: verified, status: verified ? "DOCUMENTATING_BUILD_VERIFIED" : "DOCUMENTATING_BUILD_VERIFICATION_FAILED", cwd, script: BUILD_SCRIPT, exitCode: result.exitCode, expectedTitle: expectedTitle ?? null, expectedTitleHtmlPath: titlePath, stdout: truncateOutput(result.stdout, OUTPUT_LIMIT).text, stderr: truncateOutput(result.stderr, OUTPUT_LIMIT).text };
}

async function publishSite(policy: ConsolePolicy, workspacePath: string, commitMessage: string, confirmPublish: boolean): Promise<Record<string, unknown>> {
  const cwd = resolveDocumentatingWorkspace(policy, workspacePath);
  const siteDir = path.join(cwd, SITE_DIR);
  if (!isGeneratedSite(siteDir)) throw new Error("Documentating .site_build is missing or incomplete. Run the canonical local build first.");
  if (!confirmPublish) return { ok: false, status: "CONFIRM_DOCUMENTATING_PUBLISH_REQUIRED", cwd, remote: REMOTE, targetBranch: TARGET_BRANCH, requires: { workspacePath: cwd, commitMessage, confirmPublish: true } };
  await requireGit(cwd, ["rev-parse", "--is-inside-work-tree"], "Workspace is not a Git repository.");
  await requireGit(cwd, ["remote", "get-url", REMOTE], "Documentating publish requires origin.");
  const headBefore = await gitValue(cwd, ["rev-parse", "HEAD"]);
  const statusBefore = await gitValue(cwd, ["status", "--porcelain=v1"]);
  const remoteExists = (await git(cwd, ["ls-remote", "--exit-code", REMOTE, `refs/heads/${TARGET_BRANCH}`], 60000)).ok;
  if (remoteExists) await requireGit(cwd, ["fetch", REMOTE, `${TARGET_BRANCH}:refs/remotes/${REMOTE}/${TARGET_BRANCH}`], "Unable to fetch gh-pages.");
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "console-mcp-documentating-"));
  const worktree = path.join(tempRoot, TARGET_BRANCH);
  try {
    await requireGit(cwd, ["worktree", "add", "--detach", worktree, remoteExists ? `${REMOTE}/${TARGET_BRANCH}` : "HEAD"], "Unable to create publication worktree.");
    if (!remoteExists) await requireGit(worktree, ["switch", "--orphan", TARGET_BRANCH], "Unable to create gh-pages orphan worktree.");
    for (const entry of await readdir(worktree)) if (entry !== ".git") await rm(path.join(worktree, entry), { recursive: true, force: true });
    await cp(siteDir, worktree, { recursive: true, force: true });
    await copyExtras(cwd, worktree);
    await writeFile(path.join(worktree, ".nojekyll"), "", "utf8");
    await requireGit(worktree, ["add", "-A"], "Unable to stage published site.");
    if ((await gitValue(worktree, ["status", "--porcelain=v1"])) === "") {
      const preserved = headBefore === await gitValue(cwd, ["rev-parse", "HEAD"]) && statusBefore === await gitValue(cwd, ["status", "--porcelain=v1"]);
      return { ok: preserved, status: preserved ? "DOCUMENTATING_PUBLISH_NO_CHANGES" : "DOCUMENTATING_PUBLISH_VERIFICATION_FAILED", cwd, remote: REMOTE, targetBranch: TARGET_BRANCH, currentWorktreePreserved: preserved };
    }
    await requireGit(worktree, ["-c", "commit.gpgsign=false", "commit", "-m", commitMessage.trim()], "Unable to create gh-pages deployment commit.");
    const publishSha = await gitValue(worktree, ["rev-parse", "HEAD"]);
    await requireGit(worktree, ["push", REMOTE, `HEAD:${TARGET_BRANCH}`, "--force"], "Unable to push gh-pages.");
    const remoteSha = (await gitValue(cwd, ["ls-remote", REMOTE, `refs/heads/${TARGET_BRANCH}`])).split(/\s+/)[0] || null;
    const preserved = headBefore === await gitValue(cwd, ["rev-parse", "HEAD"]) && statusBefore === await gitValue(cwd, ["status", "--porcelain=v1"]);
    const verified = preserved && remoteSha === publishSha;
    return { ok: verified, status: verified ? "DOCUMENTATING_PUBLISH_VERIFIED" : "DOCUMENTATING_PUBLISH_VERIFICATION_FAILED", cwd, remote: REMOTE, targetBranch: TARGET_BRANCH, publishSha, remoteSha, currentWorktreePreserved: preserved };
  } finally {
    await git(cwd, ["worktree", "remove", worktree, "--force"], 60000);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function resolveDocumentatingWorkspace(policy: ConsolePolicy, workspacePath: string): string {
  const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);
  for (const required of ["antora-playbook.yml", BUILD_SCRIPT, "tools/build_antora_site.py", "tools/run_antora.mjs"]) {
    if (!existsSync(path.join(cwd, ...required.split("/")))) throw new Error(`Workspace is not canonical Documentating; missing ${required}.`);
  }
  return cwd;
}

function isDirectory(candidate: string): boolean { return existsSync(candidate) && statSync(candidate).isDirectory(); }
function isGeneratedSite(candidate: string): boolean { return isDirectory(candidate) && existsSync(path.join(candidate, "index.html")) && statSync(path.join(candidate, "index.html")).isFile(); }

async function findHtmlContaining(root: string, needle: string): Promise<string | null> {
  if (!isDirectory(root)) return null;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) { const nested = await findHtmlContaining(candidate, needle); if (nested) return nested; }
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".html") && (await readFile(candidate, "utf8")).includes(needle)) return candidate;
  }
  return null;
}

async function copyExtras(cwd: string, worktree: string): Promise<void> {
  const extras = [["docs/CNAME", "CNAME"], ["assets", "assets"], ["docs/quality-atlas", "quality-atlas"], ["docs/qa-rc", "qa-rc"]] as const;
  for (const [sourceRelative, targetRelative] of extras) {
    const source = path.join(cwd, ...sourceRelative.split("/"));
    if (existsSync(source)) await cp(source, path.join(worktree, targetRelative), { recursive: statSync(source).isDirectory(), force: true });
  }
}

async function requireGit(cwd: string, args: string[], message: string): Promise<void> {
  const result = await git(cwd, args, 120000);
  if (!result.ok) throw new Error(`${message} ${truncateOutput(result.stderr, 4000).text}`.trim());
}
async function gitValue(cwd: string, args: string[]): Promise<string> { const result = await git(cwd, args, 30000); return result.ok ? result.stdout.trim() : ""; }
async function git(cwd: string, args: string[], timeoutMs: number) { return runSupervisedCommand(cwd, "git", args, timeoutMs, 4 * 1024 * 1024); }

