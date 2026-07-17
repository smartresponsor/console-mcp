[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Command,

    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]]$Arguments = @()
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$DevConsole = Join-Path $PSScriptRoot 'dev-console.ps1'

if ([string]::IsNullOrWhiteSpace($Command) -or $Command -in @('help', '--help', '-h')) {
    [pscustomobject]@{
        ok = $true
        commands = @(
            'cmcp go <component> [M<number>] [engine options]'
        )
        examples = @(
            'cmcp go vendoring M13',
            'cmcp go paying M30 --recover-composer'
        )
        note = 'cmcp go runs live by default; --live does not need to be supplied.'
    } | ConvertTo-Json -Depth 4
    exit 0
}

if ($Command -ne 'go') {
    [pscustomobject]@{
        ok = $false
        error = 'unknown_command'
        command = $Command
        expected = 'go'
        example = 'cmcp go vendoring M13'
    } | ConvertTo-Json -Depth 4
    exit 2
}

if ($Arguments.Count -eq 0 -or [string]::IsNullOrWhiteSpace([string]$Arguments[0])) {
    [pscustomobject]@{
        ok = $false
        error = 'component_required'
        example = 'cmcp go vendoring M13'
    } | ConvertTo-Json -Depth 4
    exit 2
}

$engineArguments = @('go') + @($Arguments)
if ($engineArguments -notcontains '--live') {
    $engineArguments += '--live'
}

Push-Location $Root
try {
    & pwsh -NoProfile -ExecutionPolicy Bypass -File $DevConsole engine @engineArguments
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
