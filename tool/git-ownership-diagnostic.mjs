#!/usr/bin/env node
// Read-only Git ownership diagnostic. No safe.directory overrides, chown, or config writes.
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";

const workspace = resolve(process.argv[2] ?? process.cwd());
function statPath(path) {
  try {
    const s = lstatSync(path);
    return { path, uid: s.uid, gid: s.gid, mode: (s.mode & 0o7777).toString(8), symbolicLink: s.isSymbolicLink() };
  } catch (e) { return { path, error: e.code ?? "STAT_FAILED" }; }
}
function git(args) {
  const r = spawnSync("git", args, {
    cwd: workspace, encoding: "utf8", timeout: 8000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  const stderr = r.stderr ?? "";
  return {
    ok: r.status === 0,
    exitCode: r.status,
    category: /detected dubious ownership/i.test(stderr) ? "GIT_OWNERSHIP_UNSAFE"
      : /not a git repository/i.test(stderr) ? "NOT_GIT_REPOSITORY"
      : r.error ? "EXEC_FAILURE" : r.status === 0 ? "OK" : "GIT_COMMAND_FAILED",
    // Do not emit arbitrary Git output: it can include credentials or environment details.
  };
}
const gitfile = resolve(workspace, ".git");
let gitDir;
try {
  const s = lstatSync(gitfile);
  if (s.isDirectory()) gitDir = gitfile;
  else if (s.isFile()) {
    const match = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(gitfile, "utf8"));
    if (match) gitDir = resolve(dirname(gitfile), match[1].trim());
  }
} catch {}
let commonDir;
if (gitDir) {
  try {
    const line = readFileSync(resolve(gitDir, "commondir"), "utf8").trim();
    commonDir = resolve(gitDir, line);
  } catch { commonDir = gitDir; }
}
const identity = {
  uid: process.getuid?.() ?? null,
  euid: process.geteuid?.() ?? null,
  gid: process.getgid?.() ?? null,
  egid: process.getegid?.() ?? null,
  groups: process.getgroups?.() ?? [],
};
const inspected = [workspace, gitfile, gitDir, commonDir].filter(Boolean);
const paths = [...new Set(inspected)].map(statPath);
const root = paths[0];
const mismatch = root.uid != null && identity.euid != null && root.uid !== identity.euid;
const status = git(["status", "--short"]);
const result = {
  schemaVersion: 1,
  workspace,
  identity,
  paths,
  ownerMismatch: mismatch,
  gitStatus: status,
  classification: status.category === "GIT_OWNERSHIP_UNSAFE"
    ? (mismatch ? "OWNER_UID_MISMATCH" : "GIT_TRUST_CONTEXT_MISMATCH")
    : status.category,
  note: "Diagnostic only; no trust exceptions or filesystem changes performed.",
};
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
process.exitCode = status.ok ? 0 : 2;
