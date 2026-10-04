import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, link, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveBrowserUploadPath } from "../dist/service/browser-upload-path.js";

const root = await mkdtemp(path.join(tmpdir(), "browser-upload-path-"));
try {
  const source = path.join(root, "shared artifacts");
  const mount = path.join(root, "private", "run");
  await mkdir(source); await mkdir(mount, { recursive: true });
  const backing = path.join(source, "prompt.md");
  const privatePath = path.join(mount, "prompt.md");
  await writeFile(backing, "Safe read-only attachment fixture.");
  await link(backing, privatePath);
  const escape = value => value.replace(/ /g, "\\040");
  const table = `1 0 8:1 / / rw - ext4 /dev/test rw\n2 1 8:1 ${escape(source)} ${escape(mount)} rw - ext4 /dev/test rw\n`;
  assert.equal(await resolveBrowserUploadPath(privatePath, table, "linux"), backing);
  assert.equal(await resolveBrowserUploadPath(backing, table, "linux"), backing);
  assert.equal(await resolveBrowserUploadPath(privatePath, table, "win32"), privatePath);
  assert.equal(await resolveBrowserUploadPath(backing, "", "linux"), backing);
  await rm(privatePath); await writeFile(privatePath, "Safe read-only attachment fixture.");
  await assert.rejects(resolveBrowserUploadPath(privatePath, table, "linux"), /IDENTITY_MISMATCH/);
  await rm(backing);
  await assert.rejects(resolveBrowserUploadPath(privatePath, table, "linux"), /ENOENT/);
  await assert.rejects(resolveBrowserUploadPath(privatePath, table.split("\n").slice(1).join("\n"), "linux"), /SHARED_FILESYSTEM_NOT_FOUND/);
  console.log("browser upload path regression: PASS (shared inode, escaped paths, absent/mismatched artifact, non-Linux)");
} finally {
  await rm(root, { recursive: true, force: true });
}
