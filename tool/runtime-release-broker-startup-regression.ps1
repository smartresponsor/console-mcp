$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-broker-startup.ps1')
$broker=[pscustomobject]@{generation='g';login_epoch='e';windows_session_id=1}
$valid=Get-RuntimeReleaseBrokerStartupStatus -Broker $broker -ActualSessionId 1
if (-not $valid.broker_identity_valid -or $valid.status -cne 'RELEASE_SWITCH_NOT_ENABLED' -or $valid.mutation_authorized -or -not $valid.read_only) { throw 'Valid broker startup was not read-only.' }
$mismatch=Get-RuntimeReleaseBrokerStartupStatus -Broker $broker -ActualSessionId 2
if ($mismatch.broker_identity_valid -or $mismatch.mutation_authorized) { throw 'Session mismatch accepted.' }
$broker.generation=''
$missing=Get-RuntimeReleaseBrokerStartupStatus -Broker $broker -ActualSessionId 1
if ($missing.broker_identity_valid -or $missing.mutation_authorized) { throw 'Missing generation accepted.' }
'RUNTIME_RELEASE_BROKER_STARTUP_REGRESSION_PASS'
