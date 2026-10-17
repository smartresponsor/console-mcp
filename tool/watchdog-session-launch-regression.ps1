$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/42-watchdog-task.ps1')
$StartupTaskPath = '\'
$WatchdogTaskName = 'console-mcp-watchdog'
$script:sessionId = 7
$script:invocations = 0
function Get-ConsoleSessionReport { return @{ok=($script:sessionId -gt 0); active_console=@{id=$script:sessionId}} }
$principal = @{UserId=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value}
$task = [pscustomobject]@{Definition=@{Principal=$principal}}
$task | Add-Member ScriptMethod RunEx {
    param($Arguments,$Flags,$Session,$User)
    if ($null -ne $Arguments -or $Flags -ne 4 -or $Session -ne 7 -or $null -ne $User) { throw 'Wrong interactive launch contract' }
    $script:invocations++
    return @{InstanceGuid='fixture';EnginePID=123}
}
$folder = [pscustomobject]@{Registered=$task}
$folder | Add-Member ScriptMethod GetTask { param($Name) if($Name -ne 'console-mcp-watchdog'){throw 'Wrong task'}; return $this.Registered }
$service = [pscustomobject]@{Folder=$folder}
$service | Add-Member ScriptMethod GetFolder { param($Path) if($Path -ne '\'){throw 'Wrong task folder'}; return $this.Folder }
$result = Start-WatchdogTaskInActiveSession -SchedulerService $service
if ($result.session_id -ne 7 -or $script:invocations -ne 1) { throw 'Active session not used' }
$script:sessionId = 0
$blocked = $false
try { Start-WatchdogTaskInActiveSession -SchedulerService $service | Out-Null } catch { $blocked = $true }
if (-not $blocked -or $script:invocations -ne 1) { throw 'Noninteractive session accepted' }
$script:sessionId = 7
$task.Definition.Principal.UserId = 'S-1-5-18'
$blocked = $false
try { Start-WatchdogTaskInActiveSession -SchedulerService $service | Out-Null } catch { $blocked = $true }
if (-not $blocked -or $script:invocations -ne 1) { throw 'Mismatched principal accepted' }
Write-Output 'WATCHDOG_SESSION_LAUNCH_REGRESSION_PASS (explicit console session, no constraint bypass, no session 0, matching principal)'
