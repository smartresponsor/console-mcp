param([switch]$TrustWorktree, [switch]$Full)
$ErrorActionPreference = 'Stop'
if ($TrustWorktree) {
  @'
import { registerGitInspectionTools } from './dist/tool/git-inspection.js';
import { loadConsolePolicy } from './dist/Policy/ConsolePolicy.js';
const handlers = new Map();
registerGitInspectionTools({registerTool(n,c,h){handlers.set(n,h)}}, await loadConsolePolicy(process.cwd()), {mode:'bearer',bearerTokens:[]});
const result = await handlers.get('write.repo.git.safe.directory.add')({workspacePath:process.cwd(),confirmAdd:true});
for (const item of result.content ?? []) if (item.type === 'text') console.log(item.text);
if (result.isError) process.exit(1);
'@ | node --input-type=module
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
}
$commands = @(
  @('tool/console-registration-ast-regression.mjs'),
  @('tool/infrastructure-registration-source-regression.mjs'),
  @('tool/infrastructure-integration-manifest-regression.mjs'),
  @('tool/console-tool-admission-projection-cli.mjs', '--check'),
  @('tool/chatgpt-admission-smoke.mjs')
)
foreach ($command in $commands) {
  & node @command
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
}
if ($Full) {
  if ($IsWindows) { & npm.cmd test } else { & npm test }
  exit $LASTEXITCODE
}
