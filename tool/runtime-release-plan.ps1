# Read-only candidate inspection.
param([string]$CandidatePath)
$entry = Join-Path $CandidatePath 'dist/index.js'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'Missing candidate entrypoint' }
Write-Output ('RELEASE_PLAN_READY ' + $entry)
