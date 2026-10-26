# Read-only validator regression; never starts or stops a runtime.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$WorkspacePath,
    [Parameter(Mandatory=$true)][string]$CandidatePath
)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $WorkspacePath).Path
. (Join-Path $PSScriptRoot 'dev-console.d/52-release-entrypoint.ps1')
$valid = Join-Path $CandidatePath 'dist/index.js'
$resolved = Resolve-ValidatedReleaseEntrypoint -Entrypoint $valid
if ($resolved -ine (Resolve-Path -LiteralPath $valid).Path) {
    throw 'Valid candidate was not resolved correctly.'
}
$rejected = $false
try { Resolve-ValidatedReleaseEntrypoint -Entrypoint (Join-Path $Root 'dist/index.js') | Out-Null }
catch { $rejected = $true }
if (-not $rejected) { throw 'Active workspace was accepted as release candidate.' }
$rejected = $false
try { Resolve-ValidatedReleaseEntrypoint -Entrypoint (Join-Path $CandidatePath 'missing/index.js') | Out-Null }
catch { $rejected = $true }
if (-not $rejected) { throw 'Missing entrypoint was accepted.' }
Write-Output 'RELEASE_ENTRYPOINT_REGRESSION_PASS'
