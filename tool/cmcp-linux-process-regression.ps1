param()
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$RunDir = [System.IO.Path]::GetTempPath()
. (Join-Path $PSScriptRoot 'dev-console.d/55-process-support.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/90-server-lifecycle.ps1')
function Assert-True([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
if (-not $IsLinux) { throw 'This regression requires Linux' }
function Get-CimInstance { throw 'Linux process inspection must not call CIM' }
$self = Get-ConsoleProcess -ProcessId $PID
Assert-True ($self.ProcessId -eq $PID) 'Current process missing'
Assert-True ($self.CommandLine -match 'pwsh') 'Linux argv missing'
Assert-True ($self.CreationDate -is [datetime]) 'Start time missing'
Assert-True ([bool]$self.ExecutablePath) 'Executable path missing'
Assert-True ($null -eq (Get-ConsoleProcess -ProcessId 2147483647)) 'Dead PID must be absent'
Assert-True (@(Get-ConsoleProcess | Where-Object ProcessId -eq $PID).Count -eq 1) 'Enumeration lost current process'
Assert-True ([bool](Get-ManagedProcessByMatcher -Matcher 'pwsh')) 'Matcher failed'
$count = Get-ConsoleWatchdogLoopInstanceCount
Assert-True ($count -ge 0) 'Watchdog count failed'
# Exercise the Windows branch with a strict CIM stub and restore the platform flag.
try {
    Set-Variable IsWindows -Value $true -Force
    function Get-CimInstance {
        param($ClassName, $Filter, $ErrorAction)
        Assert-True ($ClassName -eq 'Win32_Process') 'Windows class changed'
        [pscustomobject]@{ ProcessId = 42; Filter = $Filter }
    }
    Assert-True ((Get-ConsoleProcess -ProcessId 42).Filter -eq 'ProcessId = 42') 'Windows PID filter changed'
    Assert-True ((Get-ConsoleProcess).ProcessId -eq 42) 'Windows enumeration changed'
} finally { Set-Variable IsWindows -Value $false -Force }

. (Join-Path $PSScriptRoot 'dev-console.d/96-linux-restart.ps1')
$script:RestartCalls = 0
function systemctl {
    $global:LASTEXITCODE = 0
    if ($args -contains 'show') {
        'ActiveState=active'; "MainPID=$PID"; "WorkingDirectory=$Root"
    } else { $script:RestartCalls++; $global:LASTEXITCODE = 1; 'Access denied' }
}
function Get-ConsoleProcess {
    param([int]$ProcessId)
    [pscustomobject]@{ ProcessId = $ProcessId; CommandLine = "node $Root/dist/index.js" }
}
function Invoke-WebRequest { [pscustomobject]@{ StatusCode = 401 } }
$ready = Invoke-LinuxConsoleRestart -CheckOnly
Assert-True ($ready.ok -and $ready.runtime.pid -eq $PID) 'systemd preflight rejected valid runtime'
Assert-True ($script:RestartCalls -eq 0) '--check attempted a restart'
$denied = Invoke-LinuxConsoleRestart
Assert-True (-not $denied.ok -and $denied.status -eq 'SYSTEMD_RESTART_REJECTED') 'Denied restart not reported'
Assert-True ($script:RestartCalls -eq 1) 'Denied restart retried or bypassed'
function Get-ConsoleProcess { $null }
$missing = Invoke-LinuxConsoleRestart -CheckOnly
Assert-True (-not $missing.ok) 'Missing process accepted'
Assert-True ($script:RestartCalls -eq 1) 'Failed preflight attempted a restart'

[pscustomobject]@{ ok = $true; status = 'CMCP_LINUX_PROCESS_REGRESSION_PASSED' } | ConvertTo-Json
