$ErrorActionPreference='Stop'
Set-Location '/home/alex/smartresponse/mcp/.worktrees/engine-admission-287'
& npm ci --ignore-scripts --no-audit --no-fund
if($LASTEXITCODE -ne 0){throw 'NPM_CI_FAILED'}
& npm run build
if($LASTEXITCODE -ne 0){throw 'BUILD_FAILED'}
& node tool/visible-browser-session-regression.mjs
if($LASTEXITCODE -ne 0){throw 'VISIBLE_BROWSER_REGRESSION_FAILED'}
Write-Output 'ISSUE_287_LOCAL_GATES_PASS'
