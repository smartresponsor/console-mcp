# Pure transition matrix regression. No runtime mutation.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/87-release-states.ps1')
$allowed = @(
    @('PREPARED','SWITCH_REQUESTED'),
    @('PREPARED','ABORTED'),
    @('SWITCH_REQUESTED','STOP_CONFIRMED'),
    @('STOP_CONFIRMED','START_REQUESTED'),
    @('STOP_CONFIRMED','ROLLBACK_REQUESTED'),
    @('START_REQUESTED','HEALTH_VERIFYING'),
    @('HEALTH_VERIFYING','COMMITTED'),
    @('HEALTH_VERIFYING','ROLLBACK_REQUESTED'),
    @('ROLLBACK_REQUESTED','OLD_RUNTIME_RESTORED'),
    @('OLD_RUNTIME_RESTORED','ROLLED_BACK'),
    @('RECOVERY_REQUIRED','ROLLBACK_REQUESTED')
)
foreach ($pair in $allowed) {
    if (-not (Test-RuntimeReleaseTransition -From $pair[0] -To $pair[1])) {
        throw "Allowed transition rejected: $($pair -join ' -> ')"
    }
}
$forbidden = @(
    @('RECOVERY_REQUIRED','ABORTED'),
    @('PREPARED','COMMITTED'),
    @('PREPARED','STOP_CONFIRMED'),
    @('SWITCH_REQUESTED','COMMITTED'),
    @('STOP_CONFIRMED','COMMITTED'),
    @('START_REQUESTED','COMMITTED'),
    @('HEALTH_VERIFYING','ROLLED_BACK'),
    @('COMMITTED','SWITCH_REQUESTED'),
    @('ROLLED_BACK','START_REQUESTED'),
    @('ABORTED','PREPARED'),
    @('INVALID','PREPARED'),
    @('PREPARED','INVALID')
)
foreach ($pair in $forbidden) {
    if (Test-RuntimeReleaseTransition -From $pair[0] -To $pair[1]) {
        throw "Forbidden transition accepted: $($pair -join ' -> ')"
    }
}
$allStates = @('PREPARED','SWITCH_REQUESTED','STOP_CONFIRMED','START_REQUESTED',
    'HEALTH_VERIFYING','COMMITTED','ROLLBACK_REQUESTED','OLD_RUNTIME_RESTORED',
    'ROLLED_BACK','RECOVERY_REQUIRED','ABORTED')
foreach ($state in $allStates) {
    if (Test-RuntimeReleaseTransition -From $state -To $state) {
        throw "Self-transition was accepted: $state"
    }
}
foreach ($terminal in @('COMMITTED','ROLLED_BACK','ABORTED')) {
    foreach ($state in $allStates) {
        if (Test-RuntimeReleaseTransition -From $terminal -To $state) {
            throw "Terminal state escaped: $terminal -> $state"
        }
    }
}
# Isolated cryptographic envelope tests; no production key or process control.
$key = [byte[]](1..32)
$otherKey = [byte[]](33..64)
$payload = [System.Text.Encoding]::UTF8.GetBytes('transaction=abc;broker=gen1;epoch=epoch1')
$hmac = [System.Security.Cryptography.HMACSHA256]::new($key)
try { $signature = [Convert]::ToHexString($hmac.ComputeHash($payload)).ToLowerInvariant() }
finally { $hmac.Dispose() }
. (Join-Path $PSScriptRoot 'dev-console.d/89-release-receipt-validation.ps1')
if (-not (Test-RuntimeReleaseAuthenticatedReceiptEnvelope -PayloadBytes $payload -SignatureHex $signature -TrustedKey $key)) {
    throw 'Valid authenticated receipt envelope rejected.'
}
$tampered = [System.Text.Encoding]::UTF8.GetBytes('transaction=abc;broker=gen2;epoch=epoch1')
if (Test-RuntimeReleaseAuthenticatedReceiptEnvelope -PayloadBytes $tampered -SignatureHex $signature -TrustedKey $key) {
    throw 'Tampered authenticated receipt payload accepted.'
}
if (Test-RuntimeReleaseAuthenticatedReceiptEnvelope -PayloadBytes $payload -SignatureHex $signature -TrustedKey $otherKey) {
    throw 'Wrong receipt authentication key accepted.'
}
if (Test-RuntimeReleaseAuthenticatedReceiptEnvelope -PayloadBytes $payload -SignatureHex ('0' * 64) -TrustedKey $key) {
    throw 'Forged receipt signature accepted.'
}
if (Test-RuntimeReleaseAuthenticatedReceiptEnvelope -PayloadBytes $payload -SignatureHex $signature -TrustedKey ([byte[]](1..16))) {
    throw 'Short receipt authentication key accepted.'
}
Write-Output 'RELEASE_AUTHENTICATED_ENVELOPE_REGRESSION_PASS'
# Structural receipt checks are pure and must not mutate journal state.
. (Join-Path $PSScriptRoot 'dev-console.d/89-release-receipt-validation.ps1')
$journal = [pscustomobject]@{
    transaction_id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    expected_broker_generation = 'gen1'
    expected_login_epoch = 'epoch1'
    status = 'PREPARED'
    candidate_sha = ('a' * 40)
    candidate_sha256 = ('b' * 64)
    candidate_entrypoint = 'C:\candidate\dist\index.js'
    last_receipt_sequence = 0
}
$receipt = [pscustomobject]@{
    transaction_id = $journal.transaction_id
    request_id = 'req1'
    broker_generation = 'gen1'
    login_epoch = 'epoch1'
    sequence = 1
    from_state = 'PREPARED'
    to_state = 'SWITCH_REQUESTED'
    candidate_sha = $journal.candidate_sha
    candidate_sha256 = $journal.candidate_sha256
    candidate_entrypoint = $journal.candidate_entrypoint
    process_id = 1234
    process_created_at = '2026-10-25T12:00:00Z'
    process_executable = 'C:\node.exe'
    process_command_line = 'node index.js'
}
if (-not (Test-RuntimeReleaseReceipt -Journal $journal -Receipt $receipt)) {
    throw 'Matching structural receipt was rejected.'
}
foreach ($change in @(
    @{ key = 'transaction_id'; value = 'other' },
    @{ key = 'transaction_id'; value = ('g' * 32) },
    @{ key = 'broker_generation'; value = 'other' },
    @{ key = 'login_epoch'; value = 'other' },
    @{ key = 'sequence'; value = 0 },
    @{ key = 'sequence'; value = 2 },
    @{ key = 'to_state'; value = 'COMMITTED' },
    @{ key = 'candidate_sha'; value = ('c' * 40) },
    @{ key = 'process_created_at'; value = '' },
    @{ key = 'process_created_at'; value = 'not-a-date' },
    @{ key = 'process_id'; value = -1 },
    @{ key = 'process_id'; value = 'invalid' },
    @{ key = 'request_id'; value = '../invalid' },
    @{ key = 'candidate_sha256'; value = 'invalid' }
)) {
    $bad = $receipt | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $bad.($change.key) = $change.value
    if (Test-RuntimeReleaseReceipt -Journal $journal -Receipt $bad) {
        throw "Mismatched structural receipt accepted: $($change.key)"
    }
}
$overflowJournal = $journal | ConvertTo-Json -Depth 8 | ConvertFrom-Json
$overflowJournal.last_receipt_sequence = [long]::MaxValue
$overflowReceipt = $receipt | ConvertTo-Json -Depth 8 | ConvertFrom-Json
$overflowReceipt.sequence = [long]::MinValue
if (Test-RuntimeReleaseReceipt -Journal $overflowJournal -Receipt $overflowReceipt) {
    throw 'Receipt sequence wraparound was accepted.'
}
$overflowJournal.last_receipt_sequence = -1
$overflowReceipt.sequence = 0
if (Test-RuntimeReleaseReceipt -Journal $overflowJournal -Receipt $overflowReceipt) {
    throw 'Negative prior receipt sequence was accepted.'
}
Write-Output 'RELEASE_RECEIPT_STRUCTURE_REGRESSION_PASS'
# Journal schema v1 is PREPARE-only; it must not authorize a commit.
. (Join-Path $PSScriptRoot 'dev-console.d/90-release-journal-schema.ps1')
$prepared = [pscustomobject]@{
    schema_version = 1
    transaction_id = $journal.transaction_id
    status = 'PREPARED'
    candidate_entrypoint = $journal.candidate_entrypoint
    candidate_sha = $journal.candidate_sha
    candidate_sha256 = $journal.candidate_sha256
    expected_broker_generation = $journal.expected_broker_generation
    expected_login_epoch = $journal.expected_login_epoch
    created_at = '2026-10-25T12:00:00Z'
    commit_enabled = $false
    runtime_mutated = $false
}
if (-not (Test-RuntimeReleaseJournalSchema -Journal $prepared)) {
    throw 'Valid PREPARE schema rejected.'
}
foreach ($change in @(
    @{ key = 'schema_version'; value = 2 },
    @{ key = 'status'; value = 'COMMITTED' },
    @{ key = 'commit_enabled'; value = $true },
    @{ key = 'runtime_mutated'; value = $true },
    @{ key = 'transaction_id'; value = 'invalid' },
    @{ key = 'created_at'; value = 'invalid' }
)) {
    $badJournal = $prepared | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $badJournal.($change.key) = $change.value
    if (Test-RuntimeReleaseJournalSchema -Journal $badJournal) {
        throw "Invalid journal schema accepted: $($change.key)"
    }
}
$request = [pscustomobject]@{
    schema_version = 1
    action = 'release-switch'
    transaction_id = $prepared.transaction_id
    request_id = 'req-1'
    expected_broker_generation = $prepared.expected_broker_generation
    expected_login_epoch = $prepared.expected_login_epoch
    candidate_sha = $prepared.candidate_sha
    candidate_sha256 = $prepared.candidate_sha256
    candidate_entrypoint = $prepared.candidate_entrypoint
}
if (-not (Test-RuntimeReleaseSwitchRequest -Journal $prepared -Request $request)) {
    throw 'Pinned release-switch request was rejected.'
}
foreach ($change in @(
    @{ key='action'; value='restart-server' },
    @{ key='request_id'; value='../escape' },
    @{ key='transaction_id'; value=('b' * 32) },
    @{ key='candidate_sha'; value=('c' * 40) },
    @{ key='candidate_sha256'; value=('d' * 64) },
    @{ key='candidate_entrypoint'; value='C:\other\index.js' },
    @{ key='expected_broker_generation'; value='stale' },
    @{ key='expected_login_epoch'; value='stale' },
    @{ key='schema_version'; value=2 }
)) {
    $badRequest = $request | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $badRequest.($change.key) = $change.value
    if (Test-RuntimeReleaseSwitchRequest -Journal $prepared -Request $badRequest) {
        throw "Invalid release-switch request accepted: $($change.key)"
    }
}
$extraRequest = $request | ConvertTo-Json -Depth 8 | ConvertFrom-Json
$extraRequest | Add-Member -NotePropertyName 'restart_server' -NotePropertyValue $true
if (Test-RuntimeReleaseSwitchRequest -Journal $prepared -Request $extraRequest) {
    throw 'Unversioned release-switch request extension was accepted.'
}
$missingRequest = $request | ConvertTo-Json -Depth 8 | ConvertFrom-Json
$missingRequest.PSObject.Properties.Remove('candidate_sha256')
if (Test-RuntimeReleaseSwitchRequest -Journal $prepared -Request $missingRequest) {
    throw 'Incomplete release-switch request was accepted.'
}
Write-Output 'RELEASE_SWITCH_REQUEST_REGRESSION_PASS'
Write-Output 'RELEASE_JOURNAL_SCHEMA_REGRESSION_PASS'
Write-Output 'RELEASE_STATE_MACHINE_REGRESSION_PASS'
