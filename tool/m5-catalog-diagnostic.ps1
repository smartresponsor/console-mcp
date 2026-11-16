param()
$ErrorActionPreference='Stop'
& node tool/validate-console-tool-catalog.mjs
if($LASTEXITCODE -ne 0){Write-Output 'CATALOG_VALIDATION_FAIL_REPRODUCED';exit 2}
