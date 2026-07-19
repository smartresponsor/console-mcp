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
}
