$ErrorActionPreference='Stop'
$script=Join-Path $PSScriptRoot '../ops/ubuntu/script/ebay-store-browser.sh'
& /usr/bin/bash -n $script
if($LASTEXITCODE -ne 0){throw 'EBAY_BROWSER_SHELL_SYNTAX_FAILED'}
foreach($store in @('toner','general')){
  & /usr/bin/bash $script --check $store
  if($LASTEXITCODE -ne 0){throw "EBAY_STORE_PREFLIGHT_FAILED: $store"}
}
Write-Output 'EBAY_BROWSER_PREFLIGHT_PASS'
