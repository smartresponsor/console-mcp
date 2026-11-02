$ErrorActionPreference='Stop'
& node (Join-Path $PSScriptRoot 'console-tool-admission-projection-cli.mjs') --write
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
