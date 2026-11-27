import path from "node:path";
import { lstatSync, realpathSync, readFileSync, readdirSync, type Stats } from "node:fs";
import { execFileSync } from "node:child_process";
import { SMARTRESPONSE_ROOT, isOwnerManagedGitPath, assertProtectedOwnerNamespace, assertPrivateGitDirectory } from "./GitOwnershipContract.js";

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function requireRepositoryOwnerActor(cwd: string): boolean {
  if (process.platform !== "linux") return false;
  let probe = path.resolve(cwd);
  // Prevent lexical aliases outside the managed tree from bypassing routing.
  let managed = isOwnerManagedGitPath(probe);
  for (;;) {
    try { managed ||= isOwnerManagedGitPath(realpathSync(probe)); break; }
    catch (error) { if (!missing(error)) throw error; }
    const parent = path.dirname(probe);
    if (parent === probe) throw new Error("REPOSITORY_PATH_UNAVAILABLE");
    probe = parent;
  }
  if (!managed) return false;
  if (!isOwnerManagedGitPath(cwd) || path.relative(SMARTRESPONSE_ROOT, path.resolve(cwd)).split(path.sep).some(p => p.toLowerCase() === ".git")) throw new Error("GIT_OWNER_PATH_UNSAFE");
  if (process.getuid?.() !== 1000 || process.geteuid?.() !== 1000) throw new Error("GIT_OWNER_EXECUTION_REQUIRED");
  return true;
}

function ownedEntry(p: string, dev: number): Stats {
  const s = lstatSync(p);
  if (s.isSymbolicLink() || s.dev !== dev || s.uid !== 1000 || s.gid !== 1001 ||
      (s.mode & 0o022) !== 0 || (!s.isDirectory() && (!s.isFile() || s.nlink !== 1))) {
    throw new Error("GIT_MUTATION_UNSAFE_ENTRY:" + p);
  }
  if (s.isDirectory() && /^default:/m.test(execFileSync("/usr/bin/getfacl", ["-ncp", "--", p], { encoding: "utf8", timeout: 5000 }))) throw new Error("GIT_MUTATION_DEFAULT_ACL_UNSAFE:" + p);
  return s;
}

/** Resolve the marker without executing repository config or following symlinks. */
export function assertOwnerRepositoryMutationRoot(cwd: string): boolean {
  if (!requireRepositoryOwnerActor(cwd)) return false;
  const root = path.resolve(cwd);
  if (root === SMARTRESPONSE_ROOT) throw new Error("GIT_MUTATION_UMBRELLA_FORBIDDEN");
  assertProtectedOwnerNamespace(root);
  const dev = lstatSync(root).dev;
  if (!ownedEntry(root, dev).isDirectory()) throw new Error("GIT_MUTATION_ROOT_INVALID");
  const marker = path.join(root, ".git");
  const m = ownedEntry(marker, dev);
  if (m.isDirectory()) {
    assertPrivateGitDirectory(marker);
  } else {
    if (m.size > 8192) throw new Error("GIT_MUTATION_MARKER_INVALID");
    const value = readFileSync(marker, "utf8").trim();
    if (!value.startsWith("gitdir: ")) throw new Error("GIT_MUTATION_MARKER_INVALID");
    const gitdir = path.resolve(root, value.slice(8));
    const common = path.dirname(path.dirname(gitdir));
    if (!isOwnerManagedGitPath(gitdir) || path.basename(path.dirname(gitdir)) !== "worktrees" ||
        path.basename(common) !== ".git" || realpathSync(gitdir) !== gitdir) throw new Error("GIT_MUTATION_COMMON_INVALID");
    assertPrivateGitDirectory(common);
    if (!ownedEntry(gitdir, dev).isDirectory()) throw new Error("GIT_MUTATION_COMMON_INVALID");
    for (const f of ["gitdir", "commondir"]) {
      const p = path.join(gitdir, f);
      const st = ownedEntry(p, dev);
      if (!st.isFile() || st.size > 8192) throw new Error("GIT_MUTATION_POINTER_INVALID");
      const resolved = path.resolve(gitdir, readFileSync(p, "utf8").trim());
      if (resolved !== (f === "gitdir" ? marker : common)) throw new Error("GIT_MUTATION_POINTER_INVALID");
    }
  }
  return true;
}

/** No Git metadata, nested repository, symlink, hardlink, mount crossing or shared writer. */
export function assertOwnerMutationTarget(cwd: string, target: string, allowMissing = false, recursive = false, validatePath?: (p: string) => void): void {
  if (!assertOwnerRepositoryMutationRoot(cwd)) return;
  const root = path.resolve(cwd);
  const relative = path.relative(root, path.resolve(target));
  const parts = relative.split(path.sep);
  if (!relative || path.isAbsolute(relative) || parts.includes("..") || parts.some(p => p.toLowerCase() === ".git")) {
    throw new Error("GIT_MUTATION_TARGET_FORBIDDEN");
  }
  validatePath?.(path.resolve(target));
  const dev = lstatSync(root).dev;
  let p = root;
  let leaf: Stats | undefined;
  for (const part of parts) {
    p = path.join(p, part);
    try { leaf = ownedEntry(p, dev); }
    catch (error) { if (allowMissing && missing(error)) return; throw error; }
    if (leaf.isDirectory()) {
      try { lstatSync(path.join(p, ".git")); throw new Error("GIT_MUTATION_NESTED_REPOSITORY"); }
      catch (error) { if (!missing(error)) throw error; }
    } else if (p !== path.resolve(target)) throw new Error("GIT_MUTATION_ANCESTOR_NOT_DIRECTORY");
  }
  if (!recursive || !leaf?.isDirectory()) return;
  const stack = [p]; let count = 0;
  while (stack.length) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      if (++count > 10000 || name.toLowerCase() === ".git") throw new Error("GIT_MUTATION_SUBTREE_UNSAFE");
      const child = path.join(dir, name);
      validatePath?.(child);
      if (ownedEntry(child, dev).isDirectory()) stack.push(child);
    }
  }
}
