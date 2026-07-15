param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Args
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $Utf8NoBom
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom

$ScriptPath = if ($PSCommandPath) { $PSCommandPath } else { $MyInvocation.MyCommand.Path }
$BinDir = Split-Path -Parent $ScriptPath
$Root = Split-Path -Parent $BinDir
$DevConsole = if ($env:CMCP_DEV_CONSOLE_PATH) { $env:CMCP_DEV_CONSOLE_PATH } else { Join-Path $Root 'tool\dev-console.ps1' }
$ChatGptLoopCli = if ($env:CMCP_CHATGPT_LOOP_CLI_PATH) { $env:CMCP_CHATGPT_LOOP_CLI_PATH } else { Join-Path (Split-Path -Parent $Root) 'chatgpt-loop\bin\cmcp.ps1' }

function Show-CmcpUsage {
    Write-Output 'Console MCP CLI'
    Write-Output ''
    Write-Output 'Usage:'
    Write-Output '  cmcp <component> M<number> [options]'
    Write-Output '  cmcp go <component> M<number> [options]'
    Write-Output '  cmcp adopt <component> M<number> <current-chat-url>'
    Write-Output '  cmcp doctor'
    Write-Output '  cmcp --version'
    Write-Output '  Add --verbose or --diagnostic for full engine output.'
}

function Assert-File {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Label)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Write-Error "$Label not found: $Path"
        exit 1
    }
}

function Invoke-ComponentGo {
    param([Parameter(Mandatory = $true)][string[]]$CommandArgs)

    if ($CommandArgs.Count -lt 2) {
        Write-Error 'Usage: cmcp [go] <component> M<number> [options]'
        exit 2
    }

    $Component = [string]$CommandArgs[0]
    if ($Component -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$') {
        Write-Error 'Component must be a valid repository name.'
        exit 2
    }
    if ([string]$CommandArgs[1] -notmatch '^M(?:[1-9][0-9]?|100)$') {
        Write-Error 'Iteration budget must use M<number> from M1 to M100.'
        exit 2
    }

    Assert-File -Path $DevConsole -Label 'Console MCP dispatcher'
    $EngineArgs = @('engine', 'go') + @($CommandArgs)
    if (-not (@($EngineArgs) -contains '--live')) {
        $EngineArgs += '--live'
    }

    & $DevConsole @EngineArgs
    exit $LASTEXITCODE
}

if (-not $Args -or $Args.Count -eq 0) {
    Show-CmcpUsage
    exit 0
}

$CommandArgs = @($Args)
$Command = [string]$CommandArgs[0]

switch ($Command) {
    '--version' {
        Write-Output 'cmcp 1.0.0'
        exit 0
    }
    'doctor' {
        Assert-File -Path $DevConsole -Label 'Console MCP dispatcher'
        & $DevConsole doctor
        exit $LASTEXITCODE
    }
    'adopt' {
        Assert-File -Path $ChatGptLoopCli -Label 'ChatGPT Loop adoption backend'
        & $ChatGptLoopCli @CommandArgs
        exit $LASTEXITCODE
    }
    'go' {
        $Normalized = @($CommandArgs | Select-Object -Skip 1)
        Invoke-ComponentGo -CommandArgs $Normalized
    }
    default {
        Invoke-ComponentGo -CommandArgs $CommandArgs
    }
}
