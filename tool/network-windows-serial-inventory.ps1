# Fixed, passive Windows COM/USB serial inventory. No COM port is opened.
# Do not accept user-provided commands, paths, devices, or credentials.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
    $items = [System.Collections.Generic.List[object]]::new()
    $devices = @(
        Get-CimInstance -ClassName Win32_PnPEntity -Filter "PNPClass = 'Ports'" -ErrorAction Stop
    )
    foreach ($entry in $devices) {
        if ($null -ne $entry.Present -and $entry.Present -eq $false) { continue }
        $label = [string]$entry.Name
        if ($label -notmatch '\((COM[1-9][0-9]{0,3})\)') { continue }
        $port = $Matches[1]
        $id = [string]$entry.PNPDeviceID
        $vid = $null; $productId = $null
        if ($id -match '(?i)VID_([0-9A-F]{4})&PID_([0-9A-F]{4})') {
            $vid = $Matches[1].ToUpperInvariant()
            $productId = $Matches[2].ToUpperInvariant()
        }
        $items.Add([pscustomobject]@{
            device = $port
            friendlyName = $label
            manufacturer = [string]$entry.Manufacturer
            transport = if ($id -match '^USB\\') { 'usb' } elseif ($id -match '^(BTHENUM|BTH)\\') { 'bluetooth' } else { 'unknown' }
            vid = $vid
            pid = $productId
            status = [string]$entry.Status
        })
    }
    # Win32_SerialPort may expose legacy onboard COM ports not marked as Ports in PnP.
    foreach ($entry in @(Get-CimInstance -ClassName Win32_SerialPort -ErrorAction Stop)) {
        $port = [string]$entry.DeviceID
        if ($port -notmatch '^COM[1-9][0-9]{0,3}$') { continue }
        if (@($items | Where-Object { $_.device -eq $port }).Count -gt 0) { continue }
        $items.Add([pscustomobject]@{
            device = $port
            friendlyName = [string]$entry.Name
            manufacturer = [string]$entry.Manufacturer
            transport = 'unknown'
            vid = $null
            pid = $null
            status = [string]$entry.Status
        })
    }
    $sorted = @($items | Sort-Object -Property device -Unique)
    $output = @{
        ok = $true
        source = 'Win32_PnPEntity+Win32_SerialPort'
        ports = @($sorted | Select-Object -First 64)
        truncated = ($sorted.Count -gt 64)
    }
    ConvertTo-Json -InputObject $output -Compress -Depth 6
} catch {
    '{"ok":false,"reason":"WINDOWS_SERIAL_SNAPSHOT_UNAVAILABLE"}'
}
