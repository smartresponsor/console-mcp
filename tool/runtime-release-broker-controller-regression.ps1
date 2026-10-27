$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-broker-controller.ps1')
$c = New-RuntimeReleaseBrokerController -Generation 'generation-1' -LoginEpoch 'epoch-1' -SessionId 1
$params = @{ Controller=$c; TransactionId='tx-1'; ExpectedGeneration='generation-1'; ExpectedLoginEpoch='epoch-1'; ExpectedSessionId=1 }
if (-not (Test-RuntimeReleaseBrokerAdmission @params)) { throw 'Valid broker identity rejected.' }
foreach ($override in @(@{ExpectedGeneration='generation-2'},@{ExpectedLoginEpoch='epoch-2'},@{ExpectedSessionId=2},@{ExpectedGeneration=''},@{ExpectedLoginEpoch=''},@{TransactionId=''})) {
    $probe = $params.Clone()
    foreach ($key in $override.Keys) { $probe[$key] = $override[$key] }
    if (Test-RuntimeReleaseBrokerAdmission @probe) { throw ('Invalid broker identity admitted: ' + ($override | ConvertTo-Json -Compress)) }
}
Enter-RuntimeReleaseBrokerTransaction @params
if ($c.state -cne 'IN_FLIGHT' -or $c.active_transaction -cne 'tx-1') { throw 'Broker failed to retain in-memory transaction.' }
if (Test-RuntimeReleaseBrokerAdmission @params) { throw 'Duplicate transaction admitted.' }
$other = $params.Clone(); $other.TransactionId='tx-2'
if (Test-RuntimeReleaseBrokerAdmission @other) { throw 'Concurrent transaction admitted.' }
$denied = $false
try { Set-RuntimeReleaseBrokerRecoveryRequired -Controller $c -TransactionId 'tx-2' } catch { $denied = $_.Exception.Message -eq 'BROKER_TRANSACTION_IDENTITY_MISMATCH' }
if (-not $denied) { throw 'Wrong transaction changed recovery state.' }
Set-RuntimeReleaseBrokerRecoveryRequired -Controller $c -TransactionId 'tx-1'
if ($c.state -cne 'RECOVERY_REQUIRED' -or (Test-RuntimeReleaseBrokerAdmission @params)) { throw 'Recovery state permitted automatic replay.' }
$restart = New-RuntimeReleaseBrokerController -Generation 'generation-2' -LoginEpoch 'epoch-1' -SessionId 1
$stale = $params.Clone(); $stale.Controller=$restart
if (Test-RuntimeReleaseBrokerAdmission @stale) { throw 'Stale generation admitted after broker restart.' }
'RUNTIME_RELEASE_BROKER_CONTROLLER_REGRESSION_PASS'
