# Read-only GNOME RDP port audit. Do not restart services or change configuration.
$ErrorActionPreference = 'Continue'
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
# Read-only cross-user/system checks; sudo -n must never prompt or change state.
$report.sudoProbe = Capture 'sudo' @('-n','true')
$report.systemSettingsWithSudo = Capture 'sudo' @('-n','grdctl','--system','status')
$report.alexSettings = Capture 'sudo' @('-n','-u','alex','env','XDG_RUNTIME_DIR=/run/user/1000','DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus','grdctl','status')
$report.alexService = Capture 'sudo' @('-n','-u','alex','env','XDG_RUNTIME_DIR=/run/user/1000','DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus','systemctl','--user','show','gnome-remote-desktop.service','--property=LoadState,ActiveState,SubState,UnitFileState,ExecMainPID','--no-pager')
$report.xrdpService = Capture 'systemctl' @('show','xrdp.service','--property=LoadState,ActiveState','--no-pager')
$report.processes = Capture 'ps' @('-eo','user,pid,comm,args')
$report.processes.output = @($report.processes.output | Where-Object {$_ -match 'gnome-remote-desktop|gnome-shell|gdm|xrdp' } | Select-Object -First 30)
$report | ConvertTo-Json -Depth 8
