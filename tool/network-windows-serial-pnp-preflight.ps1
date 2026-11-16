# Read-only COM mapping from PnP inventory and Enum Device Parameters registry.
# Never opens COM handles or changes device settings / DTR / RTS.
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
        # Exclude Bluetooth virtual COM devices, ROOT and unapproved PnP classes.
        # Validate the system-derived ID before composing a registry path.
        if ($id -notmatch '^(?:USB|FTDIBUS|ACPI)\\[A-Z0-9_&\\-]{4,180}$') { continue }
        $key = 'Registry::HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Enum\' + $id + '\Device Parameters'
        $property = Get-ItemProperty -LiteralPath $key -Name PortName -ErrorAction Stop
        $port = [string]$property.PortName
        if ($port -notmatch '^COM(?:[1-9]|[1-9][0-9]{1,3})$') { continue }
        $rows.Add([pscustomobject]@{ device=$port; instanceId=$id; status=$status })
    }
    ConvertTo-Json -InputObject @{ok=$true;source='Get-PnpDevice+Enum_DeviceParameters_PortName';rows=@($rows)} -Compress -Depth 4
} catch {
    '{"ok":false,"reason":"WINDOWS_PNP_PREFLIGHT_UNAVAILABLE"}'
}
