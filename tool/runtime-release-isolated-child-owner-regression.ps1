$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-process-observer.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-isolated-child-owner.ps1')
$owner = New-RuntimeReleaseIsolatedChildOwner -FixturePath (Join-Path $PSScriptRoot 'runtime-release-http-child-fixture.ps1')
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0)
$listener.Start(); $port=([System.Net.IPEndPoint]$listener.LocalEndpoint).Port; $listener.Stop()
$child=$null
try {
    $child=Start-RuntimeReleaseOwnedChild -Owner $owner -Port $port
    if (-not (Test-RuntimeReleaseOwnedChild -Owner $owner -Identity $child)) { throw 'Owned child not observable' }
    $forged=[pscustomobject]@{ process=$child.process; pid=$child.pid; created=$child.created; executable=$child.executable }
    if (Test-RuntimeReleaseOwnedChild -Owner $owner -Identity $forged) { throw 'Caller identity accepted' }
    $denied=$false
    try { $null=Stop-RuntimeReleaseOwnedChild -Owner $owner -Identity $forged } catch { $denied=$_.Exception.Message -eq 'ISOLATED_CHILD_NOT_OWNED' }
    if (-not $denied) { throw 'Unowned stop admitted' }
    if (-not (Stop-RuntimeReleaseOwnedChild -Owner $owner -Identity $child)) { throw 'Owned child stop failed' }
} finally {
    if ($null -ne $child -and -not $child.process.HasExited) { $child.process.Kill(); $null=$child.process.WaitForExit(10000) }
}
'RUNTIME_RELEASE_ISOLATED_CHILD_OWNER_PASS'
