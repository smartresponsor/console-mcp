# Read-only release admission status at watchdog startup; no journal or runtime mutation.
function Get-RuntimeReleaseBrokerStartupStatus {
    param([Parameter(Mandatory=$true)]$Broker,[Parameter(Mandatory=$true)][int]$ActualSessionId)
    $valid = -not [string]::IsNullOrWhiteSpace([string]$Broker.generation) -and -not [string]::IsNullOrWhiteSpace([string]$Broker.login_epoch) -and $ActualSessionId -ge 0 -and $ActualSessionId -eq [int]$Broker.windows_session_id
    [pscustomobject]@{ status='RELEASE_SWITCH_NOT_ENABLED'; broker_identity_valid=[bool]$valid; read_only=$true; mutation_authorized=$false; recovery_automatic=$false }
}
