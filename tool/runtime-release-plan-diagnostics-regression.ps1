# Exercise planner output with an inert preflight, never production control.
$ErrorActionPreference = 'Stop'
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('release-plan-diagnostics-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path (Join-Path $sandbox 'dist')
try {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'runtime-release-plan.ps1') -Destination $sandbox
    'inert entrypoint' | Set-Content -LiteralPath (Join-Path $sandbox 'dist/index.js')
    @'
param($WorkspacePath,$CandidatePath,$ExpectedCommit)
@{ok=$true;status='DEPLOY_PREFLIGHT_READY';candidate=$CandidatePath} | ConvertTo-Json
$global:LASTEXITCODE=0
'@ | Set-Content -LiteralPath (Join-Path $sandbox 'runtime-deployment-preflight.ps1')
    $result = & (Join-Path $sandbox 'runtime-release-plan.ps1') -WorkspacePath $sandbox -CandidatePath $sandbox -ExpectedCommit ('a'*40) | ConvertFrom-Json
    if ($result.status -cne 'RELEASE_PLAN_READY' -or $result.deployment_ready -cne $false -or
        $result.commit_enabled -cne $false -or $result.runtime_mutated -cne $false -or
        $result.authorization_can_enable -cne $false -or
        $result.activation_status -cne 'RELEASE_SWITCH_POLICY_DISABLED' -or $result.implementation_schema -ne 3 -or
        @($result.blockers).Count -ne 5) { throw 'Planner confused preparation with activation capability.' }
    @{ok=$true;status='RELEASE_PLAN_DIAGNOSTICS_PASSED';productionChanged=$false} | ConvertTo-Json
} finally {
    $resolved = [IO.Path]::GetFullPath($sandbox)
    $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolved) -notmatch '^release-plan-diagnostics-[0-9a-f]{32}$') { throw 'Fixture cleanup escaped its exact generated temp path.' }
    [IO.Directory]::Delete($resolved,$true)
}
