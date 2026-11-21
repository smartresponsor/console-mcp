import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConsolePolicy } from "../dist/Policy/ConsolePolicy.js";
import { assertAllowedRoot, isWithinRoot } from "../dist/Policy/PathGuard.js";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
const originalWorkspace = process.env.CONSOLE_MCP_WORKSPACE_ROOT;
const temp = await mkdtemp(path.join(os.tmpdir(), "workspace-root-policy-"));
try {
  delete process.env.CONSOLE_MCP_WORKSPACE_ROOT;
  const policy = await loadConsolePolicy(projectRoot);
  if (process.platform === "linux") {
    assert.equal(policy.workspaceRoot, "/home/alex/smartresponse");
    assert.ok(policy.allowedRoots.includes("/home/alex/smartresponse"));
  }

  const workspace = path.join(temp, "smartresponse");
  const deepRepo = path.join(workspace, "mcp", "looping", "browsing");
  const sibling = path.join(workspace, "mcp", "console-mcp");
  const outside = path.join(temp, "outside");
  await Promise.all([mkdir(deepRepo, { recursive: true }), mkdir(sibling, { recursive: true }), mkdir(outside)]);
  const root = await realpath(workspace);

  assert.equal(assertAllowedRoot(deepRepo, [root]), await realpath(deepRepo));
  assert.equal(assertAllowedRoot(sibling, [root]), await realpath(sibling));
  assert.equal(assertAllowedRoot(path.join(deepRepo, "missing", "artifact"), [root]), path.join(await realpath(deepRepo), "missing", "artifact"));
  assert.throws(() => assertAllowedRoot(path.join(workspace, "..", "outside"), [root]), /outside the allowed roots/);
  assert.throws(() => assertAllowedRoot(`${workspace}-backup`, [root]), /outside the allowed roots/);
  assert.throws(() => assertAllowedRoot("bad\0path", [root]), /malformed/);

  const escape = path.join(workspace, "escape");
  await symlink(outside, escape, "dir");
  assert.throws(() => assertAllowedRoot(path.join(escape, "future"), [root]), /outside the allowed roots/);

  assert.equal(isWithinRoot("D:\\SmartResponse\\MCP\\Repo", "d:\\smartresponse"), true);
  assert.equal(isWithinRoot("D:\\SmartResponse-Backup\\Repo", "D:\\SmartResponse"), false);
  if (process.platform !== "win32") {
    assert.equal(isWithinRoot("/tmp/SmartResponse/repo", "/tmp/smartresponse"), false);
  }
  console.log("workspace root canonicalization regression: PASS");
} finally {
  if (originalWorkspace === undefined) delete process.env.CONSOLE_MCP_WORKSPACE_ROOT;
  else process.env.CONSOLE_MCP_WORKSPACE_ROOT = originalWorkspace;
  await rm(temp, { recursive: true, force: true });
}
