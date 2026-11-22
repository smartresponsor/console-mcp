import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, linkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
const root = mkdtempSync(join("/tmp", "safe-replace-"));
const digest = x => createHash("sha256").update(x).digest("hex");
const dir = join(root, "workspace");
const run = (file, before, updated) => {
  const r = spawnSync("python3", ["-B", "ops/ubuntu/deployment/safe-replace.py"], {
    input: JSON.stringify({ workspace: dir, path: file, before_sha256: before, updated }),
    encoding: "utf8"
  });
  return { status: r.status, result: JSON.parse(r.stdout) };
};
try {
  mkdirSync(dir);
  const target = join(dir, "file.txt"); writeFileSync(target, "alpha");
  const first = run(target, digest("alpha"), "Привіт 🌍");
  assert.equal(first.status, 0, JSON.stringify(first));
  assert.equal(readFileSync(target, "utf8"), "Привіт 🌍");
  assert.notEqual(run(target, digest("alpha"), "overwrite").status, 0);
  assert.equal(readFileSync(target, "utf8"), "Привіт 🌍");
  const link = join(root, "link"); symlinkSync(dir, link);
  assert.notEqual(run(join(link, "file.txt"), digest("Привіт 🌍"), "bad").status, 0);
  assert.equal(readFileSync(target, "utf8"), "Привіт 🌍");
  const outside = join(root, "outside.txt"); writeFileSync(outside, "protected");
  assert.notEqual(run(outside, digest("protected"), "bad").status, 0);
  assert.equal(readFileSync(outside, "utf8"), "protected");
  assert.notEqual(run(join(dir, "bad\\u0000name"), digest("protected"), "bad").status, 0);
  const hardlink = join(dir, "hardlink.txt"); linkSync(target, hardlink);
  assert.notEqual(run(target, digest("Привіт 🌍"), "bad").status, 0);
  assert.equal(readFileSync(target, "utf8"), "Привіт 🌍");
  console.log("Safe replace regression: PASS (atomic UTF-8, content mismatch, symlink parent, hardlink)");
} finally { rmSync(root, { recursive: true, force: true }); }
