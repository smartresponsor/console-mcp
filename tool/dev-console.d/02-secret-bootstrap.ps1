function Invoke-DevConsoleSecretBootstrap {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string]$Root
    )

    $requestedCommand = $Command
    $devConsoleRoot = $Root
    $mcpWorkspaceRoot = Split-Path -Parent $Root
    $sharedSecretRuntime = Join-Path $mcpWorkspaceRoot 'AwsSecretContract\tool\secret-runtime.ps1'
    $secretBootstrapCommands = @(
        'status',
        'doctor',
        'doctor-json',
        'start-server',
        'stop-server',
        'watchdog-heal',
        'smoke-local-codex'
    )

    if ($secretBootstrapCommands -contains $Command -and (Test-Path -LiteralPath $sharedSecretRuntime -PathType Leaf)) {
        & {
            . $sharedSecretRuntime -Command export-env -Consumer console-mcp -IncludePrevious
        }
    }

    $script:Root = $devConsoleRoot
    $script:Command = $requestedCommand
    $script:ErrorActionPreference = 'Stop'
}
