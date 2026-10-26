# Read-only receipt validator. No journal writes or process control.
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
    # A matching payload is necessary but not sufficient evidence of a broker action.
    # This validator does not authenticate receipts or authorize state mutation.
    return $true
}
