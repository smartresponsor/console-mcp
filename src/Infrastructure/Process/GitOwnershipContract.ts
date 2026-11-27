import path from "node:path";
import { lstatSync, realpathSync, mkdirSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";

export const SMARTRESPONSE_ROOT = "/home/alex/smartresponse";
const OWNER_UID = 1000;
const SHARED_GID = 1001;

export function isOwnerManagedGitPath(cwd: string): boolean {
  if (process.platform !== "linux") return false;
  const resolved = path.resolve(cwd);
  return resolved === SMARTRESPONSE_ROOT || resolved.startsWith(SMARTRESPONSE_ROOT + "/");
}

/** No trust grant. Git's own repository ownership check remains authoritative. */
export function nativeGitArguments(cwd: string, args: readonly string[]): string[] {
  const routing = process.platform === "linux" && process.env.CONSOLE_MCP_REPO_OWNER_ROUTING === "1";
  const resolved = path.resolve(cwd);
  if (routing && !isOwnerManagedGitPath(cwd) && isOwnerManagedGitPath(realpathSync(resolved))) throw new Error("GIT_OWNER_PATH_UNSAFE");
  if (!isOwnerManagedGitPath(cwd)) return [...args];
  if (realpathSync(resolved) !== resolved) throw new Error("GIT_OWNER_PATH_UNSAFE");
  // Only these two existing internal overrides are supported.
  let i = 0;
  while (args[i] === "-c" && ["core.editor=true", "commit.gpgsign=false"].includes(args[i + 1])) i += 2;
  if (!args[i] || !/^[a-z][a-z-]*$/.test(args[i])) throw new Error("GIT_NATIVE_SUBCOMMAND_REQUIRED");
  // Prevent the legacy trust writer from reintroducing persistent exceptions.
  if (args[i] === "config" && args.slice(i + 1).some(a => a.toLowerCase() === "safe.directory") &&
      !args.slice(i + 1).includes("--get") && !args.slice(i + 1).includes("--get-all")) {
    throw new Error("GIT_PERSISTENT_TRUST_DISABLED");
  }
  if (routing && (process.getuid?.() !== OWNER_UID || process.geteuid?.() !== OWNER_UID)) {
    const sub = args[i];
    const rest = args.slice(i+1);
    const readOnly = i === 0 && (
      ["rev-parse","status","diff","ls-files","show-ref","rev-list","merge-base","log","show","grep"].includes(sub) ||
      (sub === "reflog" && (rest.length===0 || rest[0]==="show")) ||
      (sub === "branch" && rest.length === 1 && rest[0] === "--show-current") ||
      (sub === "remote" && rest[0] === "get-url") ||
      (sub === "worktree" && rest[0] === "list") ||
      (sub === "config" && /^(?:--local|--global|--show-origin|--get|--get-all)$/.test(rest[0] ?? "") &&
        rest.filter(a=>a==="--get" || a==="--get-all").length===1 &&
        rest.every((a,j)=>j===rest.length-1 ? /^[a-zA-Z0-9.-]+$/.test(a) : ["--local","--global","--show-origin","--get","--get-all"].includes(a))) ||
      (sub === "hash-object" && rest.length===3 && rest[0]==="--no-filters" && rest[1]==="--")
    );
    // Inspection must not opt into external diff/text conversion or write modes.
    if (!readOnly || rest.some(a=>/^--(?:output(?:=|$)|ext-diff$|textconv$|write(?:=|$)|update(?:=|$))/.test(a))) throw new Error("GIT_OWNER_ROUTE_REQUIRED");
    return ["--no-optional-locks","-c","safe.directory=","-c","diff.autoRefreshIndex=false","-c","core.fsmonitor=false",...args];
  }
  return ["-c", "safe.directory=", ...args];
}

export function canonicalOwnerDirectory(cwd: string, allowRoot = false): void {
  if (!isOwnerManagedGitPath(cwd)) return;
  if (process.getuid?.() !== OWNER_UID || process.geteuid?.() !== OWNER_UID) {
    throw new Error("GIT_OWNER_EXECUTION_REQUIRED");
  }
  const resolved = path.resolve(cwd);
  if ((!allowRoot && resolved === SMARTRESPONSE_ROOT) || realpathSync(resolved) !== resolved) {
    throw new Error("GIT_OWNER_PATH_UNSAFE");
  }
  const st = lstatSync(resolved);
  if (!st.isDirectory() || st.uid !== OWNER_UID || st.gid !== SHARED_GID || (st.mode & 0o2070) !== 0o2070) {
    throw new Error("GIT_OWNER_MIGRATION_REQUIRED");
  }
}

/** Parent entry protection: a writable ancestor must be sticky and owner-controlled.
 * Same-UID owner and root are trusted; this is not a lock against owner concurrency. */
export function assertProtectedOwnerNamespace(cwd: string): void {
  if (!isOwnerManagedGitPath(cwd)) return;
  if (process.getuid?.() !== OWNER_UID || process.geteuid?.() !== OWNER_UID) throw new Error("GIT_OWNER_EXECUTION_REQUIRED");
  let p = path.resolve(cwd);
  for (;;) {
    const s = lstatSync(p);
    if (!s.isDirectory() || realpathSync(p) !== p || ![0, OWNER_UID].includes(s.uid) ||
        ((s.mode & 0o022) !== 0 && (s.mode & 0o1000) === 0)) throw new Error("GIT_NAMESPACE_PROTECTION_REQUIRED");
    const parent = path.dirname(p);
    if (parent === p) break;
    p = parent;
  }
}

export function assertPrivateGitDirectory(cwd: string): void {
  assertProtectedOwnerNamespace(cwd);
  const s = lstatSync(cwd);
  if (s.uid !== OWNER_UID || s.gid !== SHARED_GID || (s.mode & 0o777) !== 0o700) throw new Error("GIT_METADATA_PRIVATE_REQUIRED");
}

/** New directory only: remove inherited ACLs before exposing it to Git. */
function createPrivateDirectory(cwd: string, mode: number): void {
  mkdirSync(cwd, { mode: 0o700 });
  execFileSync("/usr/bin/setfacl", ["-b", "-k", "--", cwd], { timeout: 5000, stdio: "ignore" });
  chmodSync(cwd, mode);
  const s = lstatSync(cwd);
  if (s.uid !== OWNER_UID || s.gid !== SHARED_GID || (s.mode & 0o7777) !== mode) throw new Error("GIT_PRIVATE_DIRECTORY_POSTCONDITION");
}

export function admitNewOwnerRepository(cwd: string, create: boolean): void {
  if (!isOwnerManagedGitPath(cwd)) return;
  const resolved = path.resolve(cwd);
  if (resolved === SMARTRESPONSE_ROOT || path.relative(SMARTRESPONSE_ROOT, resolved).split(path.sep).some(p => p.toLowerCase() === ".git")) throw new Error("GIT_OWNER_PATH_UNSAFE");
  assertProtectedOwnerNamespace(path.dirname(resolved));
  try {
    const s = lstatSync(resolved);
    assertProtectedOwnerNamespace(resolved);
    if (s.uid !== OWNER_UID || s.gid !== SHARED_GID || (s.mode & 0o022) !== 0) throw new Error("GIT_OWNER_MIGRATION_REQUIRED");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (create) createPrivateDirectory(resolved, 0o2750);
  }
}

export function prepareNewPrivateGitDirectory(cwd: string): void {
  admitNewOwnerRepository(cwd, true);
  createPrivateDirectory(path.join(cwd, ".git"), 0o2700);
  assertPrivateGitDirectory(path.join(cwd, ".git"));
}

/** Only a new leaf under an already admitted owner directory; never chown. */
export function ensureOwnerRepositoryDirectory(cwd: string, create: boolean): boolean {
  if (!isOwnerManagedGitPath(cwd)) return false;
  if (process.getuid?.() !== OWNER_UID || process.geteuid?.() !== OWNER_UID) {
    throw new Error("GIT_OWNER_EXECUTION_REQUIRED");
  }
  const resolved = path.resolve(cwd);
  if (resolved === SMARTRESPONSE_ROOT) throw new Error("GIT_OWNER_PATH_UNSAFE");
  try {
    lstatSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    canonicalOwnerDirectory(path.dirname(resolved), true);
    if (!create) return true;
    mkdirSync(resolved, { mode: 0o2770 });
  }
  canonicalOwnerDirectory(resolved);
  return false;
}
