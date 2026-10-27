$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/87-release-states.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-event-reducer.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-replay.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-durable-events.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-journal-correlation.ps1')
$root=Join-Path $env:TEMP ('release-writer-correlation-'+[guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
    $id=[guid]::NewGuid().ToString('N')
    $stream=Join-Path $root ($id+'.events')
    New-Item -ItemType Directory -Path $stream -ErrorAction Stop | Out-Null
    $plan=[pscustomobject]@{ transaction_id=$id;status='PREPARED';commit_enabled=$false;runtime_mutated=$false;expected_broker_generation='broker';expected_login_epoch='epoch' }
    $plan | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root ($id+'.json'))
    $initial=[pscustomobject]@{transaction_id=$id;broker_generation='broker';login_epoch='epoch';status='PREPARED';sequence=[long]0}
    $event=[pscustomobject]@{transaction_id=$id;broker_generation='broker';login_epoch='epoch';from_state='PREPARED';to_state='SWITCH_REQUESTED';sequence=1}
    $saved=Add-RuntimeReleaseDurableEvent -Directory $stream -InitialSnapshot $initial -Event $event
    if ($saved.status -cne 'SWITCH_REQUESTED') { throw 'Writer did not persist expected transition' }
    $correlation=Get-RuntimeReleaseJournalCorrelation -Directory $root
    if ($correlation.reason -cne 'EVENT_STREAM_REQUIRES_AUTHENTICATED_RECONCILIATION' -or $correlation.mutation_authorized) { throw ('Writer correlation failed: '+$correlation.reason) }
    $replay=Read-RuntimeReleaseDurableEvents -Directory $stream -InitialSnapshot $initial
    if ($replay.snapshot.status -cne 'SWITCH_REQUESTED' -or -not $replay.requires_broker_reconciliation -or $replay.authenticated) { throw 'Restart replay must remain untrusted and recovery-required' }
    Set-Content -LiteralPath (Join-Path $stream '000000000002.json.tmp') -Value 'interrupted'
    $damaged=Get-RuntimeReleaseJournalCorrelation -Directory $root
    if ($damaged.reason -cne 'INVALID_EVENT_STREAM_LAYOUT' -or $damaged.mutation_authorized) { throw 'Interrupted event publication was not rejected' }
    Remove-Item -LiteralPath (Join-Path $stream '000000000002.json.tmp')
    $record=Get-Content -LiteralPath (Join-Path $stream '000000000001.json') -Raw | ConvertFrom-Json
    $record.login_epoch='forged'
    $record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stream '000000000001.json')
    $forged=Get-RuntimeReleaseJournalCorrelation -Directory $root
    if ($forged.reason -cne 'EVENT_STREAM_IDENTITY_MISMATCH' -or $forged.mutation_authorized) { throw 'Altered event identity was not rejected' }
    'RUNTIME_RELEASE_WRITER_CORRELATION_REGRESSION_PASS'
} finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
