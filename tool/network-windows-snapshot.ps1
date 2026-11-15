param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('routes','neighbors')]
    [string]$Kind
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    if ($Kind -eq 'routes') {
        $rows = @(Get-NetRoute -AddressFamily IPv4 -ErrorAction Stop |
            Sort-Object -Property DestinationPrefix,InterfaceIndex |
            Select-Object -First 129 -Property DestinationPrefix,NextHop,InterfaceAlias,RouteMetric)
    } else {
        $rows = @(Get-NetNeighbor -AddressFamily IPv4 -ErrorAction Stop |
            Sort-Object -Property IPAddress,InterfaceIndex |
            Select-Object -First 129 -Property IPAddress,LinkLayerAddress,InterfaceAlias,State)
    }
    $output = @{ ok = $true; kind = $Kind; rows = $rows; truncated = ($rows.Count -gt 128) }
    if ($rows.Count -gt 128) {
        $output.rows = @($rows | Select-Object -First 128)
    }
    ConvertTo-Json -InputObject $output -Depth 5 -Compress
    exit 0
} catch {
    '{"ok":false,"status":"WINDOWS_NETWORK_SNAPSHOT_UNAVAILABLE"}'
    exit 0
}
