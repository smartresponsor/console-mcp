$ErrorActionPreference='Stop'
$root='/home/alex/smartresponse/netmcp-pr207-validation/network-capacity-root-20261115'
Push-Location -LiteralPath $root
try {
 & npm ci --ignore-scripts --no-audit --no-fund
 if($LASTEXITCODE -ne 0){throw 'NPM_CI_FAILED'}
 & npm run build
 if($LASTEXITCODE -ne 0){throw 'BUILD_FAILED'}
 & node tool/runtime-capacity-regression.mjs
 if($LASTEXITCODE -ne 0){throw 'CAPACITY_REGRESSION_FAILED'}
 $env:GIT_CONFIG_COUNT='1'
 $env:GIT_CONFIG_KEY_0='commit.gpgsign'
 $env:GIT_CONFIG_VALUE_0='false'
 & npm test
 if($LASTEXITCODE -ne 0){throw 'NPM_TEST_FAILED'}
 Write-Output 'WINDOWS_CAPACITY_ROOT_LOCAL_GATES_PASS'
} finally { Pop-Location }
