# Startup-only read-only inspection. An absent journal is not proof that a runtime is safe to switch.
function Get-RuntimeReleaseBrokerJournalStartupDiagnostic {
    param([string]$Directory)
    if ([string]::IsNullOrWhiteSpace($Directory)) {
        return [pscustomobject]@{ status='RELEASE_JOURNAL_LOCATION_UNRESOLVED'; recovery_required=$true; inspection_ok=$false; mutation_authorized=$false }
    }
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) {
        return [pscustomobject]@{ status='RELEASE_JOURNAL_ABSENT'; recovery_required=$false; inspection_ok=$true; mutation_authorized=$false }
    }
    try {
        $files=@(Get-ChildItem -LiteralPath $Directory -Force -ErrorAction Stop)
    } catch {
        return [pscustomobject]@{ status='RELEASE_JOURNAL_INSPECTION_FAILED'; recovery_required=$true; inspection_ok=$false; mutation_authorized=$false }
    }
    if ($files.Count -eq 0) {
        return [pscustomobject]@{ status='RELEASE_JOURNAL_EMPTY'; recovery_required=$false; inspection_ok=$true; mutation_authorized=$false }
    }
    # Journal contents and terminal event claims cannot be authenticated by a shared file scan.
    return [pscustomobject]@{ status='RECOVERY_REQUIRED'; recovery_required=$true; inspection_ok=$false; mutation_authorized=$false; observed_entries=$files.Count }
}
