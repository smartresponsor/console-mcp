$ErrorActionPreference='Stop'
Write-Output 'STAGE11_READONLY_ADMIN_BOUNDARY_INSPECT'
foreach($program in @('id','namei','stat','systemctl')) {
  $cmd=Get-Command $program -ErrorAction SilentlyContinue
  Write-Output ($program+'='+[bool]$cmd)
}
Write-Output 'SERVICE_USER_IDENTITY:'
& id alex
Write-Output 'SYSTEMD_SYSTEM_SERVICE:'
& systemctl show console-mcp.service -p Id -p ActiveState -p MainPID -p User -p Group -p FragmentPath -p DynamicUser
Write-Output 'SERVICE_USER_CONSOLE_MCP:'
& id console-mcp
Write-Output 'LIVE_PRODUCTION_PID_UID_GID:'
& ps -o pid,user,group,uid,gid,args -p 715459
Write-Output 'PATH_COMPONENTS_AND_PROVENANCE:'
foreach($target in @('/opt/console-mcp-deploy','/opt/console-mcp-deploy/admission.lock','/opt/console-mcp-deploy/admission-lock.py','/var/lib/console-mcp/run','/opt/console-mcp-deploy/admission-inflight')) {
  Write-Output ('TARGET='+$target)
  & namei -l $target 2>&1 | Select-Object -Last 9
  if(Test-Path -LiteralPath $target) {& stat -c '%n owner=%u:%g mode=%a type=%F dev=%d inode=%i links=%h' -- $target}
  else{Write-Output 'NOT_PROVISIONED_OR_NOT_ACCESSIBLE'}
}
$source='ops/ubuntu/deployment/admission-lock.py'
if(Test-Path -LiteralPath $source) {
  $digest=((& sha256sum $source) -split ' ')[0]
  Write-Output ('STAGE11_SOURCE_HELPER_SHA256='+$digest)
}
Write-Output 'READONLY_ADMIN_BOUNDARY_INSPECT_COMPLETE'
