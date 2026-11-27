param([switch]$SkipBuild)
$ErrorActionPreference='Stop'
if (-not $SkipBuild) {
    & /usr/bin/npm run build
    if ($LASTEXITCODE -ne 0) { throw 'RUNTIME_TOOL_INGRESS_BUILD_FAILED' }
}
& /usr/bin/node (Join-Path $PSScriptRoot 'runtime-tool-ingress-regression.mjs')
if ($LASTEXITCODE -ne 0) { throw 'RUNTIME_TOOL_INGRESS_REGRESSION_FAILED' }
& /usr/bin/node (Join-Path $PSScriptRoot 'f30-looping-socket-regression.mjs')
if ($LASTEXITCODE -ne 0) { throw 'RUNTIME_TOOL_INGRESS_SOCKET_COMPATIBILITY_FAILED' }
