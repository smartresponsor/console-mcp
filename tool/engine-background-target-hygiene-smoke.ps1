$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$cli = Join-Path $root 'dist\cli\engine-background-target-hygiene-cli.js'

if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
    throw "Missing built hygiene CLI: $cli"
}

$output = & $node --enable-source-maps $cli "--root=$root" '--ports=9223' '--max-close=3' '--timeout-ms=3000'
if ($LASTEXITCODE -ne 0) {
    throw "Hygiene CLI failed with exit code $LASTEXITCODE"
}

$result = $output | ConvertFrom-Json -Depth 40
if ($result.ok -ne $true) { throw "Hygiene CLI did not report ok=true" }
if ($result.status -ne 'ENGINE_BACKGROUND_TARGET_HYGIENE_COMPLETE') { throw "Unexpected hygiene status: $($result.status)" }
if ($result.cleanup.policy.deletes_conversations -ne $false) { throw 'Hygiene policy must never delete conversations' }

$result | ConvertTo-Json -Depth 40
