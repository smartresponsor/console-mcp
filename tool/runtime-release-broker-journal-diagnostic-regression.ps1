$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-broker-journal-diagnostic.ps1')
$dir=Join-Path $env:TEMP ('release-journal-diagnostic-'+[guid]::NewGuid().ToString('N'))
try {
    $absent=Get-RuntimeReleaseBrokerJournalStartupDiagnostic -Directory $dir
    if ($absent.status -cne 'RELEASE_JOURNAL_ABSENT' -or $absent.mutation_authorized) { throw 'Absent journal misclassified.' }
    New-Item -ItemType Directory -Path $dir | Out-Null
    $empty=Get-RuntimeReleaseBrokerJournalStartupDiagnostic -Directory $dir
    if ($empty.status -cne 'RELEASE_JOURNAL_EMPTY' -or $empty.mutation_authorized) { throw 'Empty journal misclassified.' }
    Set-Content -LiteralPath (Join-Path $dir 'untrusted.json') -Value '{"to_state":"COMMITTED"}'
    $nonempty=Get-RuntimeReleaseBrokerJournalStartupDiagnostic -Directory $dir
    if ($nonempty.status -cne 'RECOVERY_REQUIRED' -or -not $nonempty.recovery_required -or $nonempty.mutation_authorized) { throw 'Untrusted terminal claim accepted.' }
} finally { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
'RUNTIME_RELEASE_BROKER_JOURNAL_DIAGNOSTIC_REGRESSION_PASS'
