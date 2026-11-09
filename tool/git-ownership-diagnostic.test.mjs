import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const diagnostic = resolve("tool/git-ownership-diagnostic.mjs");
function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8", timeout: 10000 });
}
function inspect(path) {
  const r = run(process.execPath, [diagnostic, path], process.cwd());
  assert.ok(r.stdout.trim(), r.stderr);
  return { code: r.status, result: JSON.parse(r.stdout) };
}
test("clean repository reports identity and safe Git status without mutation", () => {
  const dir = mkdtempSync(join(tmpdir(), "git-owner-clean-"));
  try {
    assert.equal(run("git", ["init", "-q"], dir).status, 0);
    const { code, result } = inspect(dir);
    assert.equal(code, 0);
    assert.equal(result.gitStatus.ok, true);
    assert.equal(result.classification, "OK");
    assert.equal(result.identity.euid, process.geteuid?.() ?? null);
    assert.equal(result.paths[0].targetUid, process.geteuid?.() ?? null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("non-repository fails closed with structured category", () => {
  const dir = mkdtempSync(join(tmpdir(), "git-owner-plain-"));
  try {
    const { code, result } = inspect(dir);
    assert.equal(code, 2);
    assert.equal(result.gitStatus.category, "NOT_GIT_REPOSITORY");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("linked worktree includes separate Git dir and common dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "git-owner-linked-"));
  const main = join(dir, "main");
  const linked = join(dir, "linked");
  try {
    mkdirSync(main);
    assert.equal(run("git", ["init", "-q"], main).status, 0);
    writeFileSync(join(main, "README"), "fixture");
    assert.equal(run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "add", "README"], main).status, 0);
    assert.equal(run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], main).status, 0);
    assert.equal(run("git", ["worktree", "add", "-qb", "fixture-linked", linked], main).status, 0);
    const { code, result } = inspect(linked);
    assert.equal(code, 0);
    assert.ok(result.paths.length >= 3);
    assert.ok(result.paths.some(p => p.path.includes("/worktrees/")));
    assert.equal(result.gitStatus.ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
