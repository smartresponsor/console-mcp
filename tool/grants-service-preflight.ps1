# Read-only validation of the separate grants browser service: no sudo, installs or runtime changes.
$ErrorActionPreference = 'Stop'
if (-not $IsLinux) { throw 'Linux only' }
$root = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $root 'ops/ubuntu/script/install-grants-browser.sh'
$unit = Join-Path $root 'ops/ubuntu/systemd/console-mcp-grants-browser.service'
if (-not (Test-Path -LiteralPath $installer) -or -not (Test-Path -LiteralPath $unit)) { throw 'Missing grant worker install files' }
& bash -n -- $installer
if ($LASTEXITCODE -ne 0) { throw 'GRANTS_INSTALLER_SHELL_SYNTAX_FAILED' }
$unitCheck = & systemd-analyze verify $unit 2>&1
$unitExit = $LASTEXITCODE
$preflight = & bash $installer --check 2>&1
$preflightExit = $LASTEXITCODE
[pscustomobject]@{
    installerSyntaxOk = $true
    effectiveUid = [int](& id -u)
    serviceUnitInstalled = (Test-Path -LiteralPath '/etc/systemd/system/console-mcp-grants-browser.service')
    unitVerifyExit = $unitExit
    unitVerifyMessage = @($unitCheck | ForEach-Object { [string]$_ }) | Select-Object -First 8
    preflightExit = $preflightExit
    preflightOutput = @($preflight | ForEach-Object { [string]$_ }) | Select-Object -First 8
    noPrivilegeEscalation = $true
    noRuntimeChanges = $true
} | ConvertTo-Json -Depth 6 -Compress
if ($unitExit -ne 0 -or $preflightExit -ne 0) { exit 1 }
