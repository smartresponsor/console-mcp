function Get-WatchdogTaskExpectedDeclaration {
    $launcherPath = Join-Path $RunDir 'watchdog-task-bootstrap.ps1'
    $launcherHash = if (Test-Path -LiteralPath $launcherPath -PathType Leaf) { (Get-FileHash -LiteralPath $launcherPath -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    return [pscustomobject]@{
        user_id = $identity.Name
        user_sid = $identity.User.Value
        logon_type = 'Interactive'
        run_level = 'Limited'
        execute = Resolve-WatchdogPwshPath
        arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$launcherPath`""
        working_directory = $Root
        multiple_instances = 'IgnoreNew'
        enabled = $true
        launcher_path = $launcherPath
        launcher_sha256 = $launcherHash
        triggers = [pscustomobject]@{ at_logon = $true; periodic = $true }
    }
}

function Get-WatchdogTaskActualDeclaration {
    param([Parameter(Mandatory = $true)]$Task, [object]$Info = $null)
    $action = $Task.Actions | Select-Object -First 1
    $triggers = @($Task.Triggers)
    $launcherPath = Join-Path $RunDir 'watchdog-task-bootstrap.ps1'
    $launcherHash = if (Test-Path -LiteralPath $launcherPath -PathType Leaf) { (Get-FileHash -LiteralPath $launcherPath -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }
    $principalSid = $null
    try { $principalSid = ([System.Security.Principal.NTAccount]$Task.Principal.UserId).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $principalSid = $null }
    return [pscustomobject]@{
        user_id = [string]$Task.Principal.UserId
        user_sid = $principalSid
        logon_type = [string]$Task.Principal.LogonType
        run_level = [string]$Task.Principal.RunLevel
        execute = if ($action) { [string]$action.Execute } else { $null }
        arguments = if ($action) { [string]$action.Arguments } else { $null }
        working_directory = if ($action) { [string]$action.WorkingDirectory } else { $null }
        multiple_instances = [string]$Task.Settings.MultipleInstances
        enabled = [bool]$Task.Settings.Enabled
        launcher_path = $launcherPath
        launcher_sha256 = $launcherHash
        triggers = [pscustomobject]@{
            at_logon = [bool](@($triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' -and $_.Enabled }).Count -gt 0)
            periodic = [bool](@($triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskTimeTrigger' -and $_.Enabled -and $_.Repetition.Interval }).Count -gt 0)
        }
    }
}

function Compare-WatchdogTaskDeclaration {
    param([Parameter(Mandatory = $true)]$Actual, [Parameter(Mandatory = $true)]$Expected)
    $drift = [System.Collections.Generic.List[string]]::new()
    foreach ($name in @('user_sid','logon_type','run_level','execute','arguments','working_directory','multiple_instances','enabled','launcher_sha256')) {
        if ([string]$Actual.$name -ne [string]$Expected.$name) { $drift.Add($name) | Out-Null }
    }
    foreach ($name in @('at_logon','periodic')) {
        if ([bool]$Actual.triggers.$name -ne [bool]$Expected.triggers.$name) { $drift.Add("trigger:$name") | Out-Null }
    }
    return [pscustomobject]@{
        ok = $drift.Count -eq 0
        status = if ($drift.Count -eq 0) { 'TASK_DECLARATION_MATCHES' } else { 'TASK_DEFINITION_DRIFTED' }
        drift = @($drift)
        actual = $Actual
        expected = $Expected
        next_action = if ($drift.Count -eq 0) { 'none' } else { 'run install-watchdog-task to repair the canonical declaration' }
    }
}
