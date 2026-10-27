$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-journal-correlation.ps1')
$root=Join-Path $env:TEMP ('release-correlation-'+[guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $root | Out-Null
    $empty=Get-RuntimeReleaseJournalCorrelation -Directory $root
    if ($empty.status -cne 'NO_TRANSACTION_EVIDENCE' -or $empty.mutation_authorized) { throw 'Empty journal misclassified' }
    $id=[guid]::NewGuid().ToString('N')
    $plan=[pscustomobject]@{transaction_id=$id;status='PREPARED';commit_enabled=$false;runtime_mutated=$false}
    $plan | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root ($id+'.json'))
    $prepared=Get-RuntimeReleaseJournalCorrelation -Directory $root
    if ($prepared.reason -cne 'PREPARED_WITHOUT_EVENT_STREAM' -or $prepared.mutation_authorized) { throw 'Prepared journal misclassified' }
    New-Item -ItemType Directory -Path (Join-Path $root ($id+'.events')) | Out-Null
    $linked=Get-RuntimeReleaseJournalCorrelation -Directory $root
    if ($linked.reason -cne 'EVENT_STREAM_REQUIRES_AUTHENTICATED_RECONCILIATION' -or $linked.mutation_authorized) { throw 'Linked stream incorrectly authorized' }
    Set-Content -LiteralPath (Join-Path $root 'unexpected.tmp') -Value 'partial'
    $bad=Get-RuntimeReleaseJournalCorrelation -Directory $root
    if ($bad.reason -cne 'UNEXPECTED_JOURNAL_ENTRIES' -or $bad.mutation_authorized) { throw 'Unexpected entry accepted' }
} finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
'RELEASE_JOURNAL_CORRELATION_REGRESSION_PASS'
