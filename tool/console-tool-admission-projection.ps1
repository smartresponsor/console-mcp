param(
    [ValidateSet('check','write')]
    [string] $Mode = 'check'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$node = (Get-Command node.exe -ErrorAction Stop).Source
$arg = if ($Mode -eq 'write') { '--write' } else { '--check' }
& $node (Join-Path $PSScriptRoot 'console-tool-admission-projection-cli.mjs') $arg
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
