$ErrorActionPreference='Stop'
$root=(Get-Location).Path
$env:GIT_CONFIG_COUNT='1'
$env:GIT_CONFIG_KEY_0='safe.directory'
$env:GIT_CONFIG_VALUE_0=$root
Write-Output ('STAGE06_NODE='+(& node --version))
if(!(Test-Path 'node_modules')) { & npm ci --prefer-offline --ignore-scripts --no-audit --no-fund; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}}
& npm run build
if($LASTEXITCODE -ne 0){Write-Output 'STAGE06_BUILD_FAIL';exit $LASTEXITCODE}
Write-Output 'STAGE06_BUILD_PASS'
& node tool/stage06-release-extended-http-regression.mjs
if($LASTEXITCODE -ne 0){Write-Output 'STAGE06_RELEASE_E2E_FAIL';exit $LASTEXITCODE}
Write-Output 'STAGE06_RELEASE_E2E_PASS'
foreach($group in @('repo','looping','network')) {
 & node tool/mcp-facade-http-regression.mjs $group
 if($LASTEXITCODE -ne 0){Write-Output "STAGE06_FACADE_E2E_FAIL=$group";exit $LASTEXITCODE}
 Write-Output "STAGE06_FACADE_E2E_PASS=$group"
}
& npm test
if($LASTEXITCODE -ne 0){Write-Output 'STAGE06_NPM_TEST_FAIL';exit $LASTEXITCODE}
Write-Output 'STAGE06_FULL_NPM_TEST_PASS'
