$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$entrypointPath = Join-Path $repositoryRoot 'tool/dev-console.ps1'

Describe 'dev-console module loader' {
    It 'keeps the entrypoint available' {
        Test-Path -LiteralPath $entrypointPath -PathType Leaf | Should Be $true
    }

    It 'loads numbered helper modules alphabetically and excludes browser relaunch' {
        $entrypoint = Get-Content -LiteralPath $entrypointPath -Raw

        $entrypoint | Should Match 'Get-ChildItem -LiteralPath \$DevConsoleModuleDir'
        $entrypoint | Should Match 'Sort-Object Name'
        $entrypoint | Should Match "23-browser-relaunch\.ps1"
    }

    It 'keeps watchdog compatibility markers free of business logic' {
        $watchdogMarker = Get-Content -LiteralPath (Join-Path $repositoryRoot 'tool/dev-console.d/40-watchdog.ps1') -Raw
        $orchestrationMarker = Get-Content -LiteralPath (Join-Path $repositoryRoot 'tool/dev-console.d/41-watchdog-orchestration.ps1') -Raw

        $watchdogMarker | Should Not Match '(?im)^\s*function\s+'
        $orchestrationMarker | Should Not Match '(?im)^\s*function\s+'
    }

    It 'uses explicit cadence registration instead of late function replacement' {
        $cadence = Get-Content -LiteralPath (Join-Path $repositoryRoot 'tool/dev-console.d/45-watchdog-cadence.ps1') -Raw
        $housekeeping = Get-Content -LiteralPath (Join-Path $repositoryRoot 'tool/dev-console.d/99-browser-housekeeping.ps1') -Raw

        $cadence | Should Match 'function Register-WatchdogCadenceLane'
        $housekeeping | Should Match 'Register-WatchdogCadenceLane'
        $housekeeping | Should Not Match '\$\{function:Get-WatchdogCadenceDefinition\}'
        $housekeeping | Should Not Match '(?im)^\s*function\s+Get-WatchdogCadenceDefinition\s*\{'
        $housekeeping | Should Not Match '(?im)^\s*function\s+Invoke-WatchdogCadenceLane\s*\{'
    }
}
