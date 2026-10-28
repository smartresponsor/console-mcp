# Broker-local owner for disposable test children only. Never targets a service or arbitrary PID.
function New-RuntimeReleaseIsolatedChildOwner {
    param([Parameter(Mandatory=$true)][string]$FixturePath)
    $resolved = (Resolve-Path -LiteralPath $FixturePath -ErrorAction Stop).Path
    if ([System.IO.Path]::GetFileName($resolved) -cne 'runtime-release-http-child-fixture.ps1') { throw 'ISOLATED_CHILD_FIXTURE_REQUIRED' }
    [pscustomobject]@{ fixture=$resolved; executable=[string](Get-Process -Id $PID).Path; children=[System.Collections.ArrayList]::new() }
}
function Start-RuntimeReleaseOwnedChild {
    param([Parameter(Mandatory=$true)]$Owner,[Parameter(Mandatory=$true)][ValidateRange(1,65535)][int]$Port)
    $child = Start-Process -FilePath $Owner.executable -ArgumentList @('-NoProfile','-NonInteractive','-File',('"' + $Owner.fixture + '"'),'-Port',$Port) -PassThru -WindowStyle Hidden
    try {
        $created = [datetimeoffset]$child.StartTime.ToUniversalTime()
        $identity = [pscustomobject]@{ process=$child; pid=$child.Id; created=$created; executable=$Owner.executable }
        [void]$Owner.children.Add($identity)
        return $identity
    } catch {
        if (-not $child.HasExited) { $child.Kill(); $null=$child.WaitForExit(10000) }
        throw
    }
}
function Test-RuntimeReleaseOwnedChild {
    param([Parameter(Mandatory=$true)]$Owner,[Parameter(Mandatory=$true)]$Identity)
    if (-not $Owner.children.Contains($Identity)) { return $false }
    return (Test-RuntimeReleaseIsolatedProcess -ProcessId $Identity.pid -CreatedAt $Identity.created -Executable $Identity.executable)
}
function Stop-RuntimeReleaseOwnedChild {
    param([Parameter(Mandatory=$true)]$Owner,[Parameter(Mandatory=$true)]$Identity)
    if (-not $Owner.children.Contains($Identity)) { throw 'ISOLATED_CHILD_NOT_OWNED' }
    if (-not (Test-RuntimeReleaseOwnedChild -Owner $Owner -Identity $Identity)) { return $false }
    $Identity.process.Kill(); $null=$Identity.process.WaitForExit(10000)
    return (-not (Test-RuntimeReleaseOwnedChild -Owner $Owner -Identity $Identity))
}
