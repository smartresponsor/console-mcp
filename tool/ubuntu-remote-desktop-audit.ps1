# Read-only GNOME RDP port audit. Do not restart services or change configuration.
$ErrorActionPreference = 'Continue'
if (-not $IsLinux) { @{ok=False;status='LINUX_REQUIRED'} | ConvertTo-Json; exit }
function Capture([string]$Exe, [string[]]$Parameters) {
  try {
    $lines = @(& $Exe @Parameters 2>&1 | ForEach-Object { [string]$_ })
    return @{ exitCode = $LASTEXITCODE; output = @($lines | Select-Object -First 50) }
  } catch { return @{ error = $_.Exception.Message } }
}
$report = [ordered]@{
  contract = @{remoteLogin=3389; desktopSharing=3390; transport='TCP'}
  timestampUtc = (Get-Date).ToUniversalTime().ToString('o')
  host = [Environment]::MachineName
  identity = [Environment]::UserName
}
$report.os = Capture 'cat' @('/etc/os-release')
$report.displayManager = Capture 'systemctl' @('show','display-manager.service','--property=LoadState,ActiveState,FragmentPath','--no-pager')
$report.sessions = Capture 'loginctl' @('list-sessions','--no-legend','--no-pager')
$report.packages = Capture 'dpkg-query' @('-W','gnome-remote-desktop','xrdp','gnome-shell','gdm3')
$report.listeners = Capture 'ss' @('-H','-ltnp')
$report.systemService = Capture 'systemctl' @('show','gnome-remote-desktop.service','--property=LoadState,ActiveState,SubState,UnitFileState,ExecMainPID','--no-pager')
$report.systemSocket = Capture 'systemctl' @('show','gnome-remote-desktop.socket','--property=LoadState,ActiveState,SubState,UnitFileState,Listen','--no-pager')
$report.userStatus = Capture 'systemctl' @('--user','show','gnome-remote-desktop.service','--property=LoadState,ActiveState,SubState,UnitFileState,ExecMainPID','--no-pager')
$report.grdctlSystem = Capture 'grdctl' @('--system','status')
$report.grdctlCurrentUser = Capture 'grdctl' @('status')
$report.alexUser = Capture 'loginctl' @('show-user','alex','--property=UID,Linger,State,Display','--no-pager')
$report.ports = @()
foreach ($p in @(3389,3390,9223,9224)) {
  $lines = @($report.listeners.output | Where-Object { $_ -match (':'+$p+'\s') })
  $report.ports += @{port = $p; matchingListeners = @($lines)}
}
# Cross-user privileged settings are deliberately omitted; use an independent administrator.
$report.xrdpService = Capture 'systemctl' @('show','xrdp.service','--property=LoadState,ActiveState','--no-pager')
$report.processes = Capture 'ps' @('-eo','user,pid,comm')
$report.processes.output = @($report.processes.output | Where-Object {$_ -match 'gnome-remote-desktop|gnome-shell|gdm|xrdp' } | Select-Object -First 30)
$report | ConvertTo-Json -Depth 8
