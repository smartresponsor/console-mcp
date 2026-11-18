import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSafeEnv, resolveCommandExecutable } from "../Infrastructure/Process/ProcessRuntime.js";

const execFileAsync = promisify(execFile);
const shaPattern = /^[0-9a-f]{40}$/i;

/** Simulate Git merge with all newly generated objects confined to an ephemeral object database. */
export async function inspectReadOnlyMerge(workspace: string, targetSha: string): Promise<Record<string, unknown>> {
  if (!shaPattern.test(targetSha)) throw new Error("MERGE_REVIEW_SHA_REQUIRED");
  const cwd = await realpath(workspace);
  const git = resolveCommandExecutable("git");
  const env = {
    ...buildSafeEnv(),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: cwd,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
  const run = async (args: string[], localEnv = env) => execFileAsync(git, args, {
    cwd, env: localEnv, encoding: "utf8", timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  const head = (await run(["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
  const target = (await run(["rev-parse", "--verify", `${targetSha}^{commit}`])).stdout.trim();
  const gitDir = (await run(["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
  const objects = await realpath(path.join(gitDir, "objects"));
  const temp = await mkdtemp(path.join(os.tmpdir(), "cmcp-merge-review-"));
  try {
    const objectDir = path.join(temp, "objects");
    await mkdir(objectDir);
    const isolatedEnv = {
      ...env,
      GIT_OBJECT_DIRECTORY: objectDir,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: objects,
      GIT_INDEX_FILE: path.join(temp, "index"),
    };
    try {
      const result = await run(["merge-tree", "--write-tree", "--no-messages", head, target], isolatedEnv);
      return { ok: true, status: "MERGE_CLEAN", head, target, tree: result.stdout.trim().split(/\r?\n/)[0] };
    } catch (error) {
      const result = error as { code?: number; stdout?: string; stderr?: string };
      if (result.code !== 1) throw new Error("MERGE_REVIEW_FAILED");
      return { ok: true, status: "MERGE_CONFLICT", head, target, detail: String(result.stdout ?? "").slice(0, 20000) };
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
