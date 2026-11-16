# Passive PnP COM mapping. No serial CreateFile, DCB or modem-line calls.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
    $rows = [System.Collections.Generic.List[object]]::new()
    $devices = @(Get-PnpDevice -Class Ports -PresentOnly -ErrorAction Stop)
    if ($devices.Count -gt 128) { throw 'too many devices' }
    foreach ($device in $devices) {
        $id = [string]$device.InstanceId
        $status = [string]$device.Status
        $property = Get-PnpDeviceProperty -InstanceId $id -KeyName 'DEVPKEY_Device_PortName' -ErrorAction Stop
        $port = [string]$property.Data
        if ($port -notmatch '^COM(?:[1-9]|[1-9][0-9]{1,3})$') { continue }
        $rows.Add([pscustomobject]@{ device=$port; instanceId=$id; status=$status })
    }
    ConvertTo-Json -InputObject @{ok=$true;source='Get-PnpDevice+DEVPKEY_Device_PortName';rows=@($rows)} -Compress -Depth 4
} catch {
    '{"ok":false,"reason":"WINDOWS_PNP_PREFLIGHT_UNAVAILABLE"}'
}
