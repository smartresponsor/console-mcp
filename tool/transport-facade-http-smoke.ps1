$ErrorActionPreference = "Stop"

$testPath = Join-Path $PSScriptRoot "transport-facade-http-smoke.mjs"
if (-not (Test-Path -LiteralPath $testPath -PathType Leaf)) {
    throw "Transport facade HTTP smoke test was not found: $testPath"
}

& node $testPath
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
