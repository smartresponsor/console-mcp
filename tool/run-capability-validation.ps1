$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'browser-facade-regression.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node (Join-Path $PSScriptRoot 'mcp-facade-http-regression.mjs') browser
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node (Join-Path $PSScriptRoot 'validate-console-tool-catalog.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node (Join-Path $PSScriptRoot 'validate-capability-admission.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node (Join-Path $PSScriptRoot 'validate-capability-admission-diff.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
