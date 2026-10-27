# Broker-local, in-memory transaction admission. Not an IPC authorization endpoint.
function New-RuntimeReleaseBrokerController {
    param([Parameter(Mandatory=$true)][string]$Generation,[Parameter(Mandatory=$true)][string]$LoginEpoch,[Parameter(Mandatory=$true)][int]$SessionId)
    if ([string]::IsNullOrWhiteSpace($Generation) -or [string]::IsNullOrWhiteSpace($LoginEpoch) -or $SessionId -lt 0) { throw 'BROKER_IDENTITY_REQUIRED' }
    [pscustomobject]@{ generation=$Generation; login_epoch=$LoginEpoch; session_id=$SessionId; active_transaction=$null; state='IDLE' }
}
function Test-RuntimeReleaseBrokerAdmission {
    param([Parameter(Mandatory=$true)]$Controller,[Parameter(Mandatory=$true)][AllowEmptyString()][string]$TransactionId,[Parameter(Mandatory=$true)][AllowEmptyString()][string]$ExpectedGeneration,[Parameter(Mandatory=$true)][AllowEmptyString()][string]$ExpectedLoginEpoch,[Parameter(Mandatory=$true)][int]$ExpectedSessionId)
    if ([string]::IsNullOrWhiteSpace($TransactionId) -or [string]::IsNullOrWhiteSpace($ExpectedGeneration) -or [string]::IsNullOrWhiteSpace($ExpectedLoginEpoch)) { return $false }
    if ($ExpectedGeneration -cne $Controller.generation -or $ExpectedLoginEpoch -cne $Controller.login_epoch -or $ExpectedSessionId -ne $Controller.session_id) { return $false }
    if ($Controller.state -cne 'IDLE' -or $null -ne $Controller.active_transaction) { return $false }
    return $true
}
function Enter-RuntimeReleaseBrokerTransaction {
    param([Parameter(Mandatory=$true)]$Controller,[Parameter(Mandatory=$true)][AllowEmptyString()][string]$TransactionId,[Parameter(Mandatory=$true)][AllowEmptyString()][string]$ExpectedGeneration,[Parameter(Mandatory=$true)][AllowEmptyString()][string]$ExpectedLoginEpoch,[Parameter(Mandatory=$true)][int]$ExpectedSessionId)
    if (-not (Test-RuntimeReleaseBrokerAdmission -Controller $Controller -TransactionId $TransactionId -ExpectedGeneration $ExpectedGeneration -ExpectedLoginEpoch $ExpectedLoginEpoch -ExpectedSessionId $ExpectedSessionId)) { throw 'BROKER_TRANSACTION_ADMISSION_DENIED' }
    $Controller.active_transaction = $TransactionId
    $Controller.state = 'IN_FLIGHT'
}
function Set-RuntimeReleaseBrokerRecoveryRequired {
    param([Parameter(Mandatory=$true)]$Controller,[Parameter(Mandatory=$true)][string]$TransactionId)
    if ($Controller.active_transaction -cne $TransactionId -or $Controller.state -cne 'IN_FLIGHT') { throw 'BROKER_TRANSACTION_IDENTITY_MISMATCH' }
    $Controller.state = 'RECOVERY_REQUIRED'
}
