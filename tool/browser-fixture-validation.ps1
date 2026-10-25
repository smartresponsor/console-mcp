param([switch]$TrustWorktree, [ValidateSet('fixtures', 'test', 'admission')][string]$Check = 'fixtures')
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
$failures = 0
$commands = switch ($Check) {
  'test' { ,@(@('test')) }
  'admission' { ,@(@('run','admission:check'), @('run','smoke:admission')) }
  default { ,@(@('tool/visible-browser-session-regression.mjs'), @('tool/web-domain-bridge-regression.mjs')) }
}
foreach ($command in $commands) {
  $commandArgs = @($command)
  Write-Host ('Running: ' + ($command -join ' '))
  if ($Check -ne 'fixtures') {
    if ($IsWindows) { & npm.cmd @commandArgs } else { & npm @commandArgs }
  } else { & node @commandArgs }
  $commandExit = $LASTEXITCODE
  Write-Host ('Exit code: ' + $commandExit)
  if ($commandExit) { $failures++ }
}
exit $failures
