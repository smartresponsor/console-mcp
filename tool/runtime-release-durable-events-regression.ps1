$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/87-release-states.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-event-reducer.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-replay.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-durable-events.ps1')
$directory = Join-Path $env:TEMP ('release-event-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $directory -ErrorAction Stop | Out-Null
try {
    $initial = [pscustomobject]@{
        transaction_id='test'; broker_generation='broker'; login_epoch='epoch'
        status='PREPARED'; sequence=[long]0
    }
    $event = [pscustomobject]@{
        transaction_id='test'; broker_generation='broker'; login_epoch='epoch'
        from_state='PREPARED'; to_state='SWITCH_REQUESTED'; sequence=1
    }
    $saved = Add-RuntimeReleaseDurableEvent -Directory $directory -InitialSnapshot $initial -Event $event
    if ($saved.status -cne 'SWITCH_REQUESTED') { throw 'Event was not persisted.' }
    $loaded = Read-RuntimeReleaseDurableEvents -Directory $directory -InitialSnapshot $initial
    if ($loaded.snapshot.status -cne 'SWITCH_REQUESTED' -or -not $loaded.requires_broker_reconciliation) {
        throw 'Incomplete transaction was not recovered as uncertain.'
    }
    $rejected = $false
    try { $null = Add-RuntimeReleaseDurableEvent -Directory $directory -InitialSnapshot $initial -Event $event } catch { $rejected = $true }
    if (-not $rejected) { throw 'Duplicate event accepted.' }
    if (@(Get-ChildItem -LiteralPath $directory -Filter '*.json').Count -ne 1) { throw 'Duplicate changed journal.' }
    Set-Content -LiteralPath (Join-Path $directory '000000000003.json') -Value '{}' -NoNewline
    $rejected = $false
    try { $null = Read-RuntimeReleaseDurableEvents -Directory $directory -InitialSnapshot $initial } catch { $rejected = $true }
    if (-not $rejected) { throw 'Event gap accepted.' }
    Remove-Item -LiteralPath (Join-Path $directory '000000000003.json') -Force
    Set-Content -LiteralPath (Join-Path $directory '000000000002.json.tmp') -Value 'partial' -NoNewline
    $rejected = $false
    try { $null = Read-RuntimeReleaseDurableEvents -Directory $directory -InitialSnapshot $initial } catch { $rejected = $true }
    if (-not $rejected) { throw 'Partial journal file was silently ignored.' }
    $rejected = $false
    try { $null = Add-RuntimeReleaseDurableEvent -Directory $directory -InitialSnapshot $initial -Event $event } catch { $rejected = $true }
    if (-not $rejected) { throw 'Append accepted a partial journal file.' }
    'RUNTIME_RELEASE_DURABLE_EVENTS_REGRESSION_PASS'
} finally {
    Remove-Item -LiteralPath $directory -Recurse -Force -ErrorAction SilentlyContinue
}
