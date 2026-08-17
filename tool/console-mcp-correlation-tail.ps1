param(
    [int]$Minutes = 5,
    [string]$WorkspacePath = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'

function Read-Ndjson {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Source
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return @()
    }

    $items = @()
    foreach ($line in Get-Content -LiteralPath $Path -ErrorAction Stop) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        try {
            $item = $line | ConvertFrom-Json
            $timestampText = if ($item.timestamp) { [string]$item.timestamp } elseif ($item.response_completed_at) { [string]$item.response_completed_at } else { $null }
            if ([string]::IsNullOrWhiteSpace($timestampText)) {
                continue
            }

            $timestamp = [datetime]::Parse($timestampText).ToUniversalTime()
            $items += [pscustomobject]@{
                timestamp = $timestamp
                source = $Source
                correlation_id = $item.correlation_id
                event = $item.event
                profile = $item.profile
                consumer = $item.consumer
                method = if ($item.method) { $item.method } else { $item.jsonrpc_method }
                jsonrpc_id = if ($null -ne $item.jsonrpc_id) { $item.jsonrpc_id } else { $null }
                tool_name = $item.tool_name
                auth_mode = $item.auth_mode
                auth_success = $item.auth_success
                auth_failure_class = $item.auth_failure_class
                http_status = $item.http_status
                dispatch_reached = $item.mcp_dispatch_reached
                handle_completed = $item.transport_handle_completed
                handle_threw = $item.transport_handle_threw
                finish_fired = $item.response_finish_fired
                close_fired = $item.response_close_fired
                result = $item.result_classification
                status = $item.status
                elapsed_ms = $item.elapsed_ms
                exception_class = $item.exception_class
                exception_message = $item.exception_message
            }
        } catch {
            continue
        }
    }

    return $items
}

$cutoff = (Get-Date).ToUniversalTime().AddMinutes(-[math]::Abs($Minutes))
$transcriptDir = Join-Path $WorkspacePath 'var/transcript'
$events = @()
$events += Read-Ndjson -Path (Join-Path $transcriptDir 'mcp-request-trace.ndjson') -Source 'mcp-request'
$events += Read-Ndjson -Path (Join-Path $transcriptDir 'mcp-method-trace.ndjson') -Source 'mcp-method'
$events += Read-Ndjson -Path (Join-Path $transcriptDir 'connector-refresh-trace.ndjson') -Source 'connector-refresh'

$events |
    Where-Object { $_.timestamp -ge $cutoff } |
    Sort-Object timestamp, correlation_id, source |
    Select-Object timestamp, source, correlation_id, event, profile, consumer, method, jsonrpc_id, tool_name, auth_mode, auth_success, auth_failure_class, http_status, dispatch_reached, handle_completed, handle_threw, finish_fired, close_fired, result, status, elapsed_ms, exception_class, exception_message |
    Format-Table -AutoSize
