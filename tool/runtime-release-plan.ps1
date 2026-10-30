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
$releasePolicy = Join-Path $PSScriptRoot '../policy/runtime-release-v3.json'
$enabled = (Test-Path -LiteralPath $releasePolicy) -and ((Get-Content -Raw -LiteralPath $releasePolicy | ConvertFrom-Json).productionActivationEnabled -eq $true)
[pscustomobject]@{
 status = 'RELEASE_PLAN_READY'
 candidate = $gate.candidate
 expected_sha = $ExpectedCommit
 entrypoint = $entry
 entrypoint_sha256 = (Get-FileHash -LiteralPath $entry -Algorithm SHA256).Hash.ToLowerInvariant()
 runtime_mutated = $false
 commit_enabled = [bool]$enabled
 deployment_ready = $false
 activation_status = if($enabled){'RELEASE_SWITCH_GATES_PENDING'}else{'RELEASE_SWITCH_POLICY_DISABLED'}
 implementation_schema = 3
 authorization_can_enable = $false
 blockers = @(
   'Production activation policy remains disabled until required acceptance gates pass.'
   'The active managed broker must advertise release-v3 and preserve the control root.'
   'A fresh broker-authenticated validation report must bind the exact candidate content.'
   'Rollback, authentication, configuration, native visibility and browser continuity must pass.'
   'Any legacy journal or ambiguous recovery state requires explicit reconciliation.'
 )
 next_action = 'Validate schema 3 through the managed broker; preparation alone never authorizes activation.'
} | ConvertTo-Json -Depth 4
