$ErrorActionPreference = 'Stop'
# Git's ownership check is satisfied for this exact isolated worktree only.
# Environment variables propagate to child tests; no global or system Git config writes.
$env:GIT_CONFIG_COUNT='1'
$env:GIT_CONFIG_KEY_0='safe.directory'
$env:GIT_CONFIG_VALUE_0=(Get-Location).Path
Write-Output ('STAGE04_NODE=' + (& node --version))
Write-Output ('STAGE04_NPM=' + (& npm --version))
if (!(Test-Path 'node_modules')) {
 Write-Output 'STAGE04_INSTALL_BEGIN'
 & npm ci --prefer-offline --ignore-scripts --no-audit --no-fund
 if ($LASTEXITCODE -ne 0) { Write-Output 'STAGE04_INSTALL_FAIL'; exit $LASTEXITCODE }
 Write-Output 'STAGE04_INSTALL_PASS'
}
Write-Output 'STAGE04_BUILD_BEGIN'
& npm run build
if ($LASTEXITCODE -ne 0) { Write-Output 'STAGE04_BUILD_FAIL'; exit $LASTEXITCODE }
Write-Output 'STAGE04_BUILD_PASS'
foreach ($name in @('repo','looping','network')) {
 Write-Output "STAGE04_HTTP_E2E_BEGIN=$name"
 & node tool/mcp-facade-http-regression.mjs $name
 if ($LASTEXITCODE -ne 0) { Write-Output "STAGE04_HTTP_E2E_FAIL=$name"; exit $LASTEXITCODE }
 Write-Output "STAGE04_HTTP_E2E_PASS=$name"
}
Write-Output 'STAGE04_FULL_NPM_TEST_BEGIN'
& npm test
if ($LASTEXITCODE -ne 0) { Write-Output 'STAGE04_FULL_NPM_TEST_FAIL'; exit $LASTEXITCODE }
Write-Output 'STAGE04_FULL_NPM_TEST_PASS'
