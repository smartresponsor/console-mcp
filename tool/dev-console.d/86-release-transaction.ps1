# Durable, read-only transaction preparation. Never dispatches process control.
# Read-only guard for a journal-bound incumbent snapshot.
# A missing or changed process identity cannot authorize a future commit.
function Test-RuntimeReleaseJournalIncumbent {
    param([Parameter(Mandatory=$true)]$Journal)
    if ($null -eq $Journal.PSObject.Properties['incumbent']) { return $false }
    $snapshot = $Journal.incumbent
    if ($null -eq $snapshot -or $null -eq $snapshot.PSObject.Properties['pid'] -or
        $null -eq $snapshot.PSObject.Properties['started_at']) { return $false }
    return Test-RuntimeReleaseIncumbentContinuity -Snapshot $snapshot
}
function Test-RuntimeReleaseIncumbentContinuity {
    param([Parameter(Mandatory=$true)]$Snapshot)
    $pidValue = 0
    if (-not [int]::TryParse([string]$Snapshot.pid, [ref]$pidValue) -or $pidValue -le 0) { return $false }
    $expected = [datetimeoffset]::MinValue
    if (-not [datetimeoffset]::TryParse([string]$Snapshot.started_at, [ref]$expected)) { return $false }
    try {
        $process = Get-Process -Id $pidValue -ErrorAction Stop
        if ($process.HasExited) { return $false }
        $actual = $process.StartTime.ToUniversalTime()
        return [math]::Abs(($actual - $expected.UtcDateTime).TotalMilliseconds) -lt 1
    } catch { return $false }
}
# Capture the exact incumbent process identity before any future release mutation.
# Refuse ambiguous or unhealthy runtimes; this snapshot is not a stop authorization.
function Get-RuntimeReleaseIncumbentSnapshot {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true)]$ProcessState)
    if ($ProcessState.running -cne $true -or $ProcessState.port_open -cne $true -or
        $ProcessState.port_conflict -eq $true) { return $null }
    $pidValue = 0
    if (-not [int]::TryParse([string]$ProcessState.pid, [ref]$pidValue) -or $pidValue -le 0) { return $null }
    $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    if (-not $process -or $process.HasExited) { return $null }
    $started = $null
    try { $started = $process.StartTime.ToUniversalTime().ToString('o') } catch { return $null }
    if ([string]::IsNullOrWhiteSpace($started)) { return $null }
    return [pscustomobject]@{
        pid = $pidValue
        started_at = $started
        captured_at = [datetimeoffset]::UtcNow.ToString('o')
    }
}
function Get-RuntimeReleaseJournalDirectory {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true)][string]$RuntimeDirectory)
    if ([string]::IsNullOrWhiteSpace($RuntimeDirectory)) { throw 'Runtime directory is required.' }
    return Join-Path $RuntimeDirectory 'release-transactions'
}
# Read-only COMMIT eligibility gate; success never authorizes process mutation by itself.
function Test-RuntimeReleaseCommitEligibility {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]$Request,
        [Parameter(Mandatory=$true)]$Journal,
        [Parameter(Mandatory=$true)]$Broker
    )
    if (-not (Test-RuntimeReleaseJournalSchema -Journal $Journal)) { return $false }
    if ([string]$Request.action -cne 'release-switch' -or [string]$Request.schema_version -cne '2') { return $false }
    foreach ($field in @('transaction_id','candidate_sha','candidate_sha256','candidate_entrypoint')) {
        if ([string]$Request.$field -cne [string]$Journal.$field) { return $false }
    }
    foreach ($field in @('expected_broker_generation','expected_login_epoch')) {
        if ([string]::IsNullOrWhiteSpace([string]$Request.$field) -or
            [string]$Request.$field -cne [string]$Journal.$field) { return $false }
    }
    if ([string]$Request.expected_broker_generation -cne [string]$Broker.generation -or
        [string]$Request.expected_login_epoch -cne [string]$Broker.login_epoch) { return $false }
    if ([string]::IsNullOrWhiteSpace([string]$Request.request_id) -or
        [string]$Request.request_id -cne [string]$Request.correlation_id) { return $false }
    $deadline = [datetimeoffset]::MinValue
    if (-not [datetimeoffset]::TryParse([string]$Request.deadline_at, [ref]$deadline) -or
        $deadline -le [datetimeoffset]::UtcNow) { return $false }
    $entry = [string]$Journal.candidate_entrypoint
    if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { return $false }
    try { $hash = (Get-FileHash -LiteralPath $entry -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() }
    catch { return $false }
    return $hash -ceq [string]$Journal.candidate_sha256
}
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
