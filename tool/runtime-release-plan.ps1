# Read-only release plan. No process mutation.
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$WorkspacePath,
 [Parameter(Mandatory=$true)][string]$CandidatePath,
 [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$ExpectedCommit
)
$ErrorActionPreference = 'Stop'
$gateScript = Join-Path $PSScriptRoot 'runtime-deployment-preflight.ps1'
$gateOutput = & $gateScript -WorkspacePath $WorkspacePath -CandidatePath $CandidatePath -ExpectedCommit $ExpectedCommit
if ($LASTEXITCODE -ne 0) { throw "Preflight rejected candidate: $($gateOutput | Out-String)" }
$gate = $gateOutput | Out-String | ConvertFrom-Json
if ($gate.status -ne 'DEPLOY_PREFLIGHT_READY' -or -not $gate.ok) { throw 'Preflight did not return READY' }
$entry = Join-Path $gate.candidate 'dist/index.js'
[pscustomobject]@{
 status = 'RELEASE_PLAN_READY'
 candidate = $gate.candidate
 expected_sha = $ExpectedCommit
 entrypoint = $entry
 entrypoint_sha256 = (Get-FileHash -LiteralPath $entry -Algorithm SHA256).Hash.ToLowerInvariant()
 runtime_mutated = $false
 commit_enabled = $false
} | ConvertTo-Json -Depth 4
