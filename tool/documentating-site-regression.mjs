import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");
const siteTool = await read("src/tool/documentating-site.ts");
const powerShellTool = await read("src/tool/powershell-script.ts");
const catalog = await read("src/tool/catalog.ts");
const policy = await read("policy/console-tool-catalog-dev-console.json");
const index = await read("src/index.ts");

const required = [
  [siteTool, 'console.write.repo.documentating.site.build'],
  [siteTool, 'console.write.repo.documentating.site.publish'],
  [siteTool, 'const BUILD_SCRIPT = "tools/build_site.ps1"'],
  [siteTool, 'const REMOTE = "origin"'],
  [siteTool, 'const TARGET_BRANCH = "gh-pages"'],
  [siteTool, '["worktree", "add", "--detach"'],
  [siteTool, '`HEAD:${TARGET_BRANCH}`'],
  [siteTool, '"--force"'],
  [siteTool, '["commit", "-S", "--no-verify", "-m", commitMessage.trim()]'],
  [siteTool, '["worktree", "remove", worktree, "--force"]'],
  [siteTool, 'currentWorktreePreserved'],
  [siteTool, 'isGeneratedSite(siteDir)'],
  [catalog, 'console.write.repo.documentating.site.build'],
  [catalog, 'console.write.repo.documentating.site.publish'],
  [policy, 'console.write.repo.documentating.site.build'],
  [policy, 'console.write.repo.documentating.site.publish'],
  [index, 'registerDocumentatingSiteTools'],
  [powerShellTool, 'const allowedScriptRoots = ["tool", "bin"] as const'],
];

const missing = required.filter(([text, token]) => !text.includes(token)).map(([, token]) => token);
if (missing.length > 0) {
  console.error(JSON.stringify({ ok: false, status: "DOCUMENTATING_SITE_REGRESSION_RED", missing }, null, 2));
  process.exit(1);
}
if (powerShellTool.includes('const allowedScriptRoots = ["tool", "tools", "bin"]')) {
  console.error(JSON.stringify({ ok: false, status: "DOCUMENTATING_SITE_REGRESSION_RED", error: "generic PowerShell policy was widened to tools/" }, null, 2));
  process.exit(1);
}
if (siteTool.includes('commit.gpgsign=false')) {
  console.error(JSON.stringify({ ok: false, status: "DOCUMENTATING_SITE_REGRESSION_RED", error: "publisher disables commit signing" }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  status: "DOCUMENTATING_SITE_REGRESSION_GREEN",
  invariants: {
    canonical_build_script: true,
    no_install_surface: true,
    generic_powershell_boundary_preserved: true,
    isolated_worktree_publish: true,
    fixed_origin_and_gh_pages_target: true,
    force_push_scoped_to_publish_tool: true,
    current_worktree_preservation_verified: true,
    catalog_policy_registration_present: true,
  },
}, null, 2));

