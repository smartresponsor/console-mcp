param()
$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
Push-Location $root
try{ & node 'tool/ask-loopback-bearer-regression.mjs'; exit $LASTEXITCODE }finally{Pop-Location}
