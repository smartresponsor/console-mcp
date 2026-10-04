import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const moduleUrl = pathToFileURL(path.join(root, "dist/service/chatgpt-entrypoint-preset.js")).href;
const foreign = mkdtempSync(path.join(tmpdir(), "engine-prompt-path-"));
const probe = `
  const { buildChatGptEntrypointPlan } = await import(process.argv[1]);
  console.log(JSON.stringify(['go', 'adopt'].map(executionMode =>
    buildChatGptEntrypointPlan({
      rawPrompt: 'Read-only task. Do not modify, stage, commit, or push the target repository.',
      workspacePath: '/read-only-fixture/addressing', componentName: 'addressing',
      taskPreset: 'repo_rc_implementation', executionAuthority: 'READ_ONLY', executionMode,
    }).enrichedPrompt)));
`;
function render(cwd) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe, moduleUrl], {
    cwd, encoding: "utf8",
  });
  assert.equal(result.status, 0, `Template loading failed from ${cwd}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
try {
  const expected = render(root);
  assert.equal(expected.length, 2);
  for (const prompt of expected) {
    assert.ok(prompt.includes('/read-only-fixture/addressing'));
    assert.ok(!prompt.includes('{{workspacePath}}'));
    assert.ok(prompt.includes('READ_ONLY'));
  }
  const locations = [...new Set([path.parse(root).root, homedir(), tmpdir(), foreign, root])];
  for (const cwd of locations) assert.deepEqual(render(cwd), expected);
  console.log(JSON.stringify({ ok: true, status: "ENGINE_PROMPT_PATH_GREEN", modes: ["go", "adopt"], cwd_count: locations.length }));
} finally {
  rmSync(foreign, { recursive: true, force: true });
}
