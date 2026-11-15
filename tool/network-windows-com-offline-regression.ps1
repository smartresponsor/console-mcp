#Requires -Version 7.0
# Windows COM hardware-free policy fixture. No Get-CimInstance, port open, P/Invoke or device control.
$ErrorActionPreference = 'Stop'
function Test-FixedComProfile {
    param([object] $Request)
    if ($null -eq $Request -or $Request -isnot [System.Collections.IDictionary]) { return $false }
    $keys = @($Request.Keys)
    if ($keys.Count -ne 6) { return $false }
    foreach ($key in $keys) {
        if ($key -cnotin @('deviceId','profile','baudRate','authorized','dtr','rts')) { return $false }
    }
    return [bool](
        $Request.deviceId -ceq 'COM7' -and
        $Request.profile -ceq 'status-only' -and
        $Request.baudRate -in @(9600,115200) -and
        $Request.authorized -ceq $true -and
        $Request.dtr -ceq $false -and
        $Request.rts -ceq $false
    )
}
$valid = @{ deviceId='COM7'; profile='status-only'; baudRate=9600; authorized=$true; dtr=$false; rts=$false }
if (-not (Test-FixedComProfile $valid)) { throw 'VALID_FIXED_PROFILE_DENIED' }
foreach ($mutation in @(
    @{ deviceId='COM8' }, @{ profile='configure' }, @{ baudRate=230400 },
    @{ authorized=$false }, @{ dtr=$true }, @{ rts=$true },
    @{ command='show running-config' }
)) {
    $candidate = @{} + $valid
    foreach ($k in $mutation.Keys) { $candidate[$k]=$mutation[$k] }
    if (Test-FixedComProfile $candidate) { throw "UNSAFE_PROFILE_ACCEPTED:$($mutation.Keys -join ',')" }
}
# Simulated COM has no OS handle, no SerialPort instantiation, and cannot toggle DTR/RTS.
Write-Output 'NETWORK_WINDOWS_COM_OFFLINE_POLICY_PASS'
