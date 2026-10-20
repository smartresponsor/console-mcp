$ErrorActionPreference='Stop'
$unit='console-mcp-desktop-agent.service'
$socket='/run/console-mcp-desktop/agent.sock'
$uid=(& /usr/bin/id -u).Trim()
$runtimeDir="/run/user/$uid"
$bus=Join-Path $runtimeDir 'bus'
$result=[ordered]@{unit=$unit;uid=$uid;userBusAvailable=(Test-Path -LiteralPath $bus -PathType Leaf);serviceStatus='not_checked';serviceDetails=@();socketPresent=(Test-Path -LiteralPath $socket);socketDetails=$null;warnings=@()}
if($result.userBusAvailable){
 $env:XDG_RUNTIME_DIR=$runtimeDir
 $env:DBUS_SESSION_BUS_ADDRESS="unix:path=$bus"
 $result.serviceStatus=((& /usr/bin/systemctl --user is-active $unit 2>&1) -join ' ').Trim()
 if($LASTEXITCODE -ne 0){$result.warnings+=('Service not active or inaccessible: '+$result.serviceStatus)}
 $result.serviceDetails=@(& /usr/bin/systemctl --user show $unit --property=MainPID,ActiveState,SubState 2>&1)
 if($LASTEXITCODE -ne 0){$result.warnings+='Cannot read user service details'}
}else{
 $result.serviceStatus='user_bus_unavailable'
 $result.warnings+='User D-Bus is unavailable in this execution context; service state not inferred'
}
if($result.socketPresent){$result.socketDetails=((& /usr/bin/stat -c '%A %U %G %n' $socket 2>&1) -join ' ').Trim()}
$result | ConvertTo-Json -Depth 5
if(-not $result.socketPresent){exit 1}
