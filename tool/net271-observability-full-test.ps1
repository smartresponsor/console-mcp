$ErrorActionPreference='Stop'
$root=(Get-Location).Path
Push-Location $root
try {
  $env:NODE_COMPILE_CACHE='/tmp/net271-node-compile-cache'
  $env:PYTHONDONTWRITEBYTECODE='1'
  & npm ci --no-audit --no-fund *> /tmp/net271-native-proof-observability-install.log
  if($LASTEXITCODE -ne 0){throw 'NPM_CI_FAILED'}
  & npm run build *> /tmp/net271-native-proof-observability-build.log
  if($LASTEXITCODE -ne 0){Get-Content /tmp/net271-native-proof-observability-build.log -Tail 50;throw 'BUILD_FAILED'}
  & npm test *> /tmp/net271-native-proof-observability-npm-test.log
  $code=$LASTEXITCODE
  Get-Content /tmp/net271-native-proof-observability-npm-test.log -Tail 70
  if($code -ne 0){throw "NPM_TEST_FAILED=$code"}
  Write-Output 'NET271_FULL_NPM_TEST_PASS'
} finally {Pop-Location}
