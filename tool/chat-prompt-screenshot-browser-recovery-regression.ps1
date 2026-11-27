$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $root 'ops/ubuntu/script/run-browser.sh'
$unit = Join-Path $root 'ops/ubuntu/systemd/console-mcp-browser.service'
& bash -n $launcher
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$script = Get-Content -LiteralPath $launcher -Raw
$service = Get-Content -LiteralPath $unit -Raw
$boundary = $script.IndexOf('state_dir="/var/lib/console-mcp-browser"')
if ($boundary -lt 0) { throw 'ISOLATED_MODE_BOUNDARY_MISSING' }
if ($script.Substring(0,$boundary).Contains('--disable-setuid-sandbox')) { throw 'VISIBLE_MODE_CHANGED' }
if ([regex]::Matches($script,'--disable-setuid-sandbox').Count -ne 1) { throw 'NAMESPACE_SANDBOX_FLAG_INVALID' }
if ($script -match '--no-sandbox|--disable-seccomp-filter-sandbox|--disable-namespace-sandbox') { throw 'SANDBOX_DOWNGRADE' }
foreach ($line in @('AppArmorProfile=msedge','NoNewPrivileges=yes','CapabilityBoundingSet=','AmbientCapabilities=','RestrictNamespaces=user pid net ipc mnt uts','ProtectSystem=strict','ProtectHome=read-only','PrivateTmp=true','PrivateDevices=true','Restart=on-failure')) {
    if ($service -notmatch ('(?m)^' + [regex]::Escape($line) + '\r?$')) { throw "SERVICE_CONTRACT_MISSING: $line" }
}
Write-Output 'BROWSER_RECOVERY_SOURCE_REGRESSION_PASS (static contract; production unchanged)'
