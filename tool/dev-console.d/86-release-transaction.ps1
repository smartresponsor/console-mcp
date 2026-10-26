# Durable, read-only transaction preparation. Never dispatches process control.
function New-RuntimeReleaseTransactionPlan {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$CandidateEntrypoint,
        [Parameter(Mandatory=$true)][string]$ExpectedCommit,
        [Parameter(Mandatory=$true)][string]$JournalDirectory
    )
    if ($ExpectedCommit -notmatch '^[0-9a-fA-F]{40}$') {
        throw 'ExpectedCommit must be a full 40-character Git SHA.'
    }
    $entry = Resolve-ValidatedReleaseEntrypoint -Entrypoint $CandidateEntrypoint
    $candidate = Split-Path -Parent (Split-Path -Parent $entry)
    $actual = (& git -C $candidate rev-parse HEAD | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $actual -ine $ExpectedCommit) {
        throw 'Candidate SHA does not match ExpectedCommit.'
    }
    if (-not (Test-Path -LiteralPath $JournalDirectory -PathType Container)) {
        throw 'Journal directory must already exist.'
    }
    $lockPath = Join-Path $JournalDirectory '.release-transaction.lock'
    $lock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    try {
    $pending = @(Get-ChildItem -LiteralPath $JournalDirectory -File -ErrorAction Stop)
    foreach ($item in $pending) {
        if ($item.Name -eq '.release-transaction.lock') { continue }
        if ($item.Extension -ne '.json') {
            throw 'Unexpected file in release transaction journal directory.'
        }
    }
    foreach ($file in $pending) {
        if ($file.Name -eq '.release-transaction.lock') { continue }
        $previous = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
        if ($previous.status -eq 'PREPARED' -and
            (-not (Test-RuntimeReleaseJournalSchema -Journal $previous) -or
             $file.BaseName -cne [string]$previous.transaction_id)) {
            throw 'Invalid prepared release journal.'
        }
        # No authenticated terminal receipt exists in schema v1. Fail closed.
        if ($previous.status -in @('ROLLED_BACK','COMMITTED','ABORTED')) {
            throw 'Terminal journal requires authenticated watchdog evidence.'
        }
        if ($previous.status -notin @('ROLLED_BACK','COMMITTED','ABORTED')) {
            throw 'Another release transaction is incomplete.'
        }
    }
    $broker = Get-ServerControlBrokerIdentity
    if (-not $broker -or [string]::IsNullOrWhiteSpace([string]$broker.generation) -or
        [string]::IsNullOrWhiteSpace([string]$broker.login_epoch)) {
        throw 'Interactive watchdog broker identity is unavailable.'
    }
    $id = [guid]::NewGuid().ToString('N')
    $plan = [pscustomobject]@{
        schema_version = 1
        transaction_id = $id
        status = 'PREPARED'
        candidate_entrypoint = $entry
        candidate_sha = $actual
        candidate_sha256 = (Get-FileHash -LiteralPath $entry -Algorithm SHA256).Hash.ToLowerInvariant()
        expected_broker_generation = [string]$broker.generation
        expected_login_epoch = [string]$broker.login_epoch
        created_at = (Get-Date).ToUniversalTime().ToString('o')
        commit_enabled = $false
        runtime_mutated = $false
    }
    if (-not (Test-RuntimeReleaseJournalSchema -Journal $plan)) {
        throw 'Prepared journal failed schema validation.'
    }
    $target = Join-Path $JournalDirectory "$id.json"
    Write-ServerControlJsonAtomically -Path $target -Value $plan
    return $plan
    } finally {
        $lock.Dispose()
    }
}
