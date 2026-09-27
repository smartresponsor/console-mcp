import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const tempDir = await mkdtemp(path.join(os.tmpdir(), "console-mcp-rc-async-"));
const configPath = path.join(tempDir, "rc-plan.json");

const config = {
  workspacePath: root,
  component: "console-mcp",
  target: "async-rc-regression",
  mode: "plan",
  maxFiles: 50,
  maxIssues: 20,
  runEnvelope: {
    dirty_policy: "allow_existing_readonly",
    validation_profile: "auto",
    allowed_paths: [],
    forbidden_paths: [],
    repair_limit: 0,
    repair_apply_approved: false,
    repair_patch: null,
    repair_expected_changed_files: [],
    commit_message: null,
    advisor_mode: "optional",
    commit_policy: "none",
    push_policy: "none",
    pr_policy: "none",
    active_capabilities: ["diagnose", "validate", "plan_contract"],
    inactive_capabilities: ["repair_write_loop", "commit", "push", "pull_request"],
  },
  writeEvidence: false,
  timeoutMs: 30000,
};

try {
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const result = await runNode(["dist/tool/rc-async-runner.js", configPath]);
  assert.equal(result.exitCode, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.tool, "console.rc");
  assert.equal(parsed.mode, "plan");
  assert.equal(parsed.workspace_path, root);
  assert.equal(parsed.validation_results, null);
  console.log(JSON.stringify({
    ok: true,
    mode: parsed.mode,
    workspace_path: parsed.workspace_path,
    readiness_status: parsed.readiness?.status ?? null,
  }, null, 2));
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

async function runNode(args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}
