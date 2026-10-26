# Pure transition matrix regression. No runtime mutation.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/87-release-states.ps1')
$allowed = @(
    @('PREPARED','SWITCH_REQUESTED'),
    @('PREPARED','ABORTED'),
    @('SWITCH_REQUESTED','STOP_CONFIRMED'),
    @('STOP_CONFIRMED','START_REQUESTED'),
    @('STOP_CONFIRMED','ROLLBACK_REQUESTED'),
    @('START_REQUESTED','HEALTH_VERIFYING'),
    @('HEALTH_VERIFYING','COMMITTED'),
    @('HEALTH_VERIFYING','ROLLBACK_REQUESTED'),
    @('ROLLBACK_REQUESTED','OLD_RUNTIME_RESTORED'),
    @('OLD_RUNTIME_RESTORED','ROLLED_BACK'),
    @('RECOVERY_REQUIRED','ROLLBACK_REQUESTED')
)
foreach ($pair in $allowed) {
    if (-not (Test-RuntimeReleaseTransition -From $pair[0] -To $pair[1])) {
        throw "Allowed transition rejected: $($pair -join ' -> ')"
    }
}
$forbidden = @(
    @('RECOVERY_REQUIRED','ABORTED'),
    @('PREPARED','COMMITTED'),
    @('PREPARED','STOP_CONFIRMED'),
    @('SWITCH_REQUESTED','COMMITTED'),
    @('STOP_CONFIRMED','COMMITTED'),
    @('START_REQUESTED','COMMITTED'),
    @('HEALTH_VERIFYING','ROLLED_BACK'),
    @('COMMITTED','SWITCH_REQUESTED'),
    @('ROLLED_BACK','START_REQUESTED'),
    @('ABORTED','PREPARED'),
    @('INVALID','PREPARED'),
    @('PREPARED','INVALID')
)
foreach ($pair in $forbidden) {
    if (Test-RuntimeReleaseTransition -From $pair[0] -To $pair[1]) {
        throw "Forbidden transition accepted: $($pair -join ' -> ')"
    }
}
$allStates = @('PREPARED','SWITCH_REQUESTED','STOP_CONFIRMED','START_REQUESTED',
    'HEALTH_VERIFYING','COMMITTED','ROLLBACK_REQUESTED','OLD_RUNTIME_RESTORED',
    'ROLLED_BACK','RECOVERY_REQUIRED','ABORTED')
foreach ($state in $allStates) {
    if (Test-RuntimeReleaseTransition -From $state -To $state) {
        throw "Self-transition was accepted: $state"
    }
}
foreach ($terminal in @('COMMITTED','ROLLED_BACK','ABORTED')) {
    foreach ($state in $allStates) {
        if (Test-RuntimeReleaseTransition -From $terminal -To $state) {
            throw "Terminal state escaped: $terminal -> $state"
        }
    }
}
Write-Output 'RELEASE_STATE_MACHINE_REGRESSION_PASS'
