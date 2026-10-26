# Read-only structural validation. Never authorizes process control or journal writes.
function Test-RuntimeReleaseReceipt {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]$Journal,
        [Parameter(Mandatory=$true)]$Receipt
    )
    $required = @('transaction_id','request_id','broker_generation','login_epoch',
        'sequence','from_state','to_state','candidate_sha','candidate_sha256',
        'candidate_entrypoint','process_id','process_created_at','process_executable',
        'process_command_line')
    foreach ($field in $required) {
        if ($null -eq $Receipt.PSObject.Properties[$field]) { return $false }
        if ([string]::IsNullOrWhiteSpace([string]$Receipt.$field)) { return $false }
    }
    if ([string]$Receipt.transaction_id -cnotmatch '^[0-9a-f]{32}$') { return $false }
    if ([string]$Journal.transaction_id -cnotmatch '^[0-9a-f]{32}$') { return $false }
    if ([string]$Receipt.request_id -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') { return $false }
    if ([string]$Receipt.candidate_sha -cnotmatch '^[0-9a-f]{40}$') { return $false }
    if ([string]$Receipt.candidate_sha256 -cnotmatch '^[0-9a-f]{64}$') { return $false }
    $pidValue = 0
    if (-not [int]::TryParse([string]$Receipt.process_id, [ref]$pidValue) -or $pidValue -le 0) { return $false }
    $createdAt = [datetimeoffset]::MinValue
    if (-not [datetimeoffset]::TryParse([string]$Receipt.process_created_at, [ref]$createdAt)) { return $false }
    if ([string]$Receipt.transaction_id -cne [string]$Journal.transaction_id) { return $false }
    if ([string]$Receipt.broker_generation -cne [string]$Journal.expected_broker_generation) { return $false }
    if ([string]$Receipt.login_epoch -cne [string]$Journal.expected_login_epoch) { return $false }
    if ([string]$Receipt.from_state -cne [string]$Journal.status) { return $false }
    if ([string]$Receipt.candidate_sha -cne [string]$Journal.candidate_sha) { return $false }
    if ([string]$Receipt.candidate_sha256 -cne [string]$Journal.candidate_sha256) { return $false }
    if ([string]$Receipt.candidate_entrypoint -cne [string]$Journal.candidate_entrypoint) { return $false }
    if (-not (Test-RuntimeReleaseTransition -From ([string]$Receipt.from_state) -To ([string]$Receipt.to_state))) { return $false }
    $seq = 0L
    if (-not [long]::TryParse([string]$Receipt.sequence, [ref]$seq) -or $seq -le 0) { return $false }
    $previous = 0L
    if ($Journal.PSObject.Properties.Name -contains 'last_receipt_sequence') {
        if (-not [long]::TryParse([string]$Journal.last_receipt_sequence, [ref]$previous)) { return $false }
    }
    if ($seq -ne ($previous + 1)) { return $false }
    # This predicate is structural only: callers must not treat true as authority
    # to mutate a journal, dispatch process control, or admit a new PREPARE.
    # Broker authentication and observed runtime evidence remain mandatory.
    # Structural agreement is not broker authentication or evidence of execution.
    return $true
}
