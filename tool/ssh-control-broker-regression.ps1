$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$RunDir = Join-Path $root 'var\test-ssh-control-broker'
function Ensure-Directories { New-Item -ItemType Directory -Force -Path $RunDir | Out-Null }
function Ensure-BuildOutput { [pscustomobject]@{ build_current = $true } }
function Start-WatchdogLoop { '{"running":true}' }
function Get-WatchdogLoopProcessState { [pscustomobject]@{ running = $true; pid = 1 } }
function Get-ConsoleSessionReport { [pscustomobject]@{ active_console = [pscustomobject]@{ id = 1 } } }
function Sanitize-Text([string]$Text) { $Text }
. (Join-Path $root 'tool\dev-console.d\85-session-relay.ps1')

Remove-Item -LiteralPath $ServerControlRoot -Recurse -Force -ErrorAction SilentlyContinue
Initialize-ServerControlQueue
$broker = [pscustomobject]@{
    generation = 'generation-a'
    pid = 10
    windows_session_id = 1
    login_epoch = 'session:1:20260713'
    heartbeat_sequence = 0
    heartbeat_at = (Get-Date).ToUniversalTime().ToString('o')
}
Write-ServerControlBrokerIdentity -Identity $broker

foreach ($id in @('request-a', 'request-b')) {
    $request = [pscustomobject]@{
        schema_version = 2
        correlation_id = $id
        action = 'stop-server'
        requested_at = (Get-Date).ToUniversalTime().ToString('o')
        requested_by_session = 0
        expected_broker_generation = 'generation-a'
        expected_login_epoch = 'session:1:20260713'
    }
    Write-ServerControlJsonAtomically -Path (Join-Path $ServerControlInboxDir "$id.json") -Value $request
}

$items = @(Get-ChildItem -LiteralPath $ServerControlInboxDir -Filter '*.json')
if ($items.Count -ne 2) { throw 'Concurrent requests were not preserved.' }

$first = $items | Sort-Object Name | Select-Object -First 1
$claimed = Join-Path $ServerControlClaimedDir $first.Name
Move-Item -LiteralPath $first.FullName -Destination $claimed -ErrorAction Stop
if ((Test-Path -LiteralPath $first.FullName) -or -not (Test-Path -LiteralPath $claimed)) { throw 'Atomic claim failed.' }

$stale = Get-Content -LiteralPath $claimed -Raw | ConvertFrom-Json
$stale.expected_broker_generation = 'generation-old'
if ([string]$stale.expected_broker_generation -eq [string]$broker.generation) { throw 'Stale generation test setup failed.' }

$broker = Update-ServerControlBrokerHeartbeat -Identity $broker
if ([int64]$broker.heartbeat_sequence -ne 1) { throw 'Broker heartbeat sequence did not advance.' }

Write-Output '{"ok":true,"status":"SSH_CONTROL_BROKER_REGRESSION_GREEN"}'
