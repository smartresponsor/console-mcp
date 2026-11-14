function Invoke-DevConsoleSecretBootstrap {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string]$Root
    )

    $requestedCommand = $Command
    $devConsoleRoot = $Root
    # Resolve the shared secret runtime across normal and nested Git worktrees.
    $sharedSecretRuntime = $null
    $searchRoot = $Root
    for ($depth = 0; $depth -lt 6 -and $searchRoot; $depth++) {
        $candidate = Join-Path $searchRoot 'AwsSecretContract/tool/secret-runtime.ps1'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $sharedSecretRuntime = $candidate
            break
        }
        $parent = Split-Path -Parent $searchRoot
        if ($parent -eq $searchRoot) { break }
        $searchRoot = $parent
    }
    $secretBootstrapCommands = @(
        'status',
        'doctor',
        'doctor-json',
        'start-server',
        'stop-server',
        'watchdog-heal',
        'smoke-local-codex'
    )

    if ($secretBootstrapCommands -contains $Command -and -not [string]::IsNullOrWhiteSpace($sharedSecretRuntime)) {
        & {
            . $sharedSecretRuntime -Command export-env -Consumer console-mcp -IncludePrevious
        }
    }

    $script:Root = $devConsoleRoot
    $script:Command = $requestedCommand
    $script:ErrorActionPreference = 'Stop'
}
