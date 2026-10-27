# Read-only correlation of prepared journal records and transaction event directories.
# Filesystem data is untrusted and never grants replay or mutation authority.
function Get-RuntimeReleaseJournalCorrelation {
    param([Parameter(Mandatory=$true)][string]$Directory)
    $result = [ordered]@{ status='RECOVERY_REQUIRED'; reason='UNCLASSIFIED'; recovery_required=$true; mutation_authorized=$false; automatic_replay_allowed=$false; prepared_count=0; event_stream_count=0 }
    try {
        if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { $result.reason='JOURNAL_ABSENT'; return [pscustomobject]$result }
        $items = @(Get-ChildItem -LiteralPath $Directory -Force -ErrorAction Stop)
        $plans = @($items | Where-Object { -not $_.PSIsContainer -and $_.Name -cmatch '^[0-9a-f]{32}\.json$' })
        $streams = @($items | Where-Object { $_.PSIsContainer -and $_.Name -cmatch '^[0-9a-f]{32}\.events$' })
        $result.prepared_count=$plans.Count
        $result.event_stream_count=$streams.Count
        $unexpected = @($items | Where-Object { $_.Name -cne '.release-transaction.lock' -and $_ -notin $plans -and $_ -notin $streams })
        if ($unexpected.Count -gt 0) { $result.reason='UNEXPECTED_JOURNAL_ENTRIES'; return [pscustomobject]$result }
        if ($plans.Count -eq 0 -and $streams.Count -eq 0) { $result.status='NO_TRANSACTION_EVIDENCE'; $result.reason='EMPTY'; $result.recovery_required=$false; return [pscustomobject]$result }
        if ($plans.Count -ne 1 -or $streams.Count -gt 1) { $result.reason='AMBIGUOUS_TRANSACTION_SET'; return [pscustomobject]$result }
        $plan = Get-Content -LiteralPath $plans[0].FullName -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        if ([string]$plan.transaction_id -cne $plans[0].BaseName -or [string]$plan.status -cne 'PREPARED' -or $plan.commit_enabled -cne $false -or $plan.runtime_mutated -cne $false) { $result.reason='INVALID_PREPARED_RECORD'; return [pscustomobject]$result }
        if ($streams.Count -eq 0) { $result.reason='PREPARED_WITHOUT_EVENT_STREAM'; return [pscustomobject]$result }
        if ($streams[0].Name -cne ($plan.transaction_id + '.events')) { $result.reason='TRANSACTION_ID_MISMATCH'; return [pscustomobject]$result }
        $result.reason='EVENT_STREAM_REQUIRES_AUTHENTICATED_RECONCILIATION'
        return [pscustomobject]$result
    } catch {
        $result.reason='JOURNAL_READ_FAILED'
        return [pscustomobject]$result
    }
}
