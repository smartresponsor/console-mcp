$ErrorActionPreference='Stop'
$workspace='/home/alex/smartresponse/netmcp-pr207-validation/network-m2-serial-20261115'
Push-Location $workspace
try {
  & npm ci --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'NPM_CI_FAILED' }
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw 'BUILD_FAILED' }
  $env:GIT_CONFIG_COUNT='1'
  $env:GIT_CONFIG_KEY_0='commit.gpgsign'
  $env:GIT_CONFIG_VALUE_0='false'
  & npm test
  if ($LASTEXITCODE -ne 0) { throw 'FULL_LOCAL_REGRESSION_FAILED' }
  Write-Output 'M2_VIRTUAL_SERIAL_LOCAL_ACCEPTANCE_PASS'
} finally { Pop-Location }
