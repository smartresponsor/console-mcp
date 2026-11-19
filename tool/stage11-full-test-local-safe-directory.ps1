$ErrorActionPreference='Stop'
$worktree=(Get-Location).Path
$oldCount=$env:GIT_CONFIG_COUNT; $oldKey=$env:GIT_CONFIG_KEY_0; $oldValue=$env:GIT_CONFIG_VALUE_0
try {
  $env:GIT_CONFIG_COUNT='1'
  $env:GIT_CONFIG_KEY_0='safe.directory'
  $env:GIT_CONFIG_VALUE_0=$worktree
  & npm run build
  if($LASTEXITCODE -ne 0){throw 'BUILD_FAILED'}
  & node tool/stage11-admission-integration-regression.mjs
  if($LASTEXITCODE -ne 0){throw 'ADMISSION_INTEGRATION_FAILED'}
  & npm test
  if($LASTEXITCODE -ne 0){throw 'FULL_NPM_TEST_FAILED'}
  Write-Output 'STAGE11_FULL_NPM_TEST_PASS'
} finally {
  if($null -eq $oldCount){Remove-Item Env:GIT_CONFIG_COUNT -ErrorAction SilentlyContinue}else{$env:GIT_CONFIG_COUNT=$oldCount}
  if($null -eq $oldKey){Remove-Item Env:GIT_CONFIG_KEY_0 -ErrorAction SilentlyContinue}else{$env:GIT_CONFIG_KEY_0=$oldKey}
  if($null -eq $oldValue){Remove-Item Env:GIT_CONFIG_VALUE_0 -ErrorAction SilentlyContinue}else{$env:GIT_CONFIG_VALUE_0=$oldValue}
}
