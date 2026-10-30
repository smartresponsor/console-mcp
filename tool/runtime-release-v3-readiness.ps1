# Read-only host acceptance; never wakes/focuses a window or changes a task/runtime.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ControlRoot,[Parameter(Mandatory=$true)][string]$RollbackPath)
$ErrorActionPreference='Stop'
if(-not $IsWindows){throw 'Windows host acceptance required'}
. (Join-Path $PSScriptRoot 'dev-console.d/01-runtime-config.ps1')
Initialize-DevConsoleRuntimeConfig -EntryScriptRoot $PSScriptRoot -ControlRoot $ControlRoot
Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'dev-console.d') -Filter '*.ps1' -File | Sort-Object Name | ForEach-Object {. $_.FullName}
$checks=[Collections.Generic.List[object]]::new()
function Add-Readiness([string]$Name,[bool]$Passed,$Detail){$checks.Add(@{name=$Name;passed=$Passed;detail=$Detail})}
$broker=Get-ServerControlBrokerIdentity
Add-Readiness 'production-broker-v3' ($broker.supported_actions -contains 'release-v3') @{pid=$broker.pid;session=$broker.windows_session_id}
$policy=Get-Content -Raw (Join-Path $PSScriptRoot '../policy/runtime-release-v3.json') | ConvertFrom-Json
Add-Readiness 'production-policy-enabled' ($policy.productionActivationEnabled -eq $true) 'Shipping policy remains disabled pending on-host acceptance.'
$legacy=Join-Path $RunDir 'release-transactions'
$legacyCount=if(Test-Path -LiteralPath $legacy){@(Get-ChildItem -LiteralPath $legacy -Filter '*.json').Count}else{0}
Add-Readiness 'legacy-journals-reconciled' ($legacyCount -eq 0) @{count=$legacyCount}
try {
 $probe=& (Join-Path $PSScriptRoot 'runtime-release-v3-candidate-probe.ps1') -CandidatePath (Split-Path -Parent $PSScriptRoot) -ControlRoot $ControlRoot | Out-String | ConvertFrom-Json
 Add-Readiness 'candidate-authenticated-host-config' ([bool]$probe.ok) @{fingerprint=$probe.fingerprint;registry=$probe.registry}
}catch{Add-Readiness 'candidate-authenticated-host-config' $false 'Isolated candidate probe failed; inspect protected diagnostics.'}
try {
 $backup=Get-ReleaseV3Descriptor $RollbackPath 'rollback-verification'
 $equal=$true
 foreach($name in $backup.files.Keys){
  $live=Join-Path $ControlRoot $name
  if(-not (Test-Path -LiteralPath $live) -or (Get-FileHash -LiteralPath $live -Algorithm SHA256).Hash.ToLowerInvariant() -cne $backup.files[$name]){$equal=$false;break}
 }
 Add-Readiness 'rollback-content-exact' $equal @{files=$backup.files.Count;fingerprint=(Get-ReleaseV3BuildFingerprint $RollbackPath);path=$RollbackPath}
}catch{Add-Readiness 'rollback-content-exact' $false 'Rollback content verification failed.'}
try {
 $native=& (Join-Path $PSScriptRoot 'visible-browser-native-windows.ps1') -Port 9223 -Operation browser | ConvertFrom-Json
 $foreground=@($native.windows | Where-Object {$_.id -eq $native.foregroundWindowIdAfter -and $_.visible -and -not $_.minimized -and $_.cloaked -eq 0}).Count -gt 0
 Add-Readiness 'native-desktop-foreground' ([bool]($native.sameSession -and $native.sameUser -and $native.inputReady -and $foreground)) @{sameUser=$native.sameUser;sameSession=$native.sameSession;inputReady=$native.inputReady;foreground=$foreground}
}catch{Add-Readiness 'native-desktop-foreground' $false 'Native visibility could not be verified without interaction.'}
try {
 $snapshot=Get-ReleaseV3BrowserSnapshot
 Add-Readiness 'browser-worker-snapshot' $true @{listeningPorts=@($snapshot.Keys | Where-Object {$snapshot[$_]})}
}catch{Add-Readiness 'browser-worker-snapshot' $false 'Browser/worker identity snapshot unavailable.'}
$smoke=Invoke-CodexSmoke -Origin $CodexOrigin -Label 'release-readiness' -Quiet
$h=$smoke.authenticated_smoke.health
$health=if($h.structuredContent){$h.structuredContent}elseif($h.content){$h.content[0].text | ConvertFrom-Json}else{$null}
Add-Readiness 'current-authenticated-health' ([bool]($smoke.ok -and $health.ok)) @{pid=$health.pid;fingerprint=$health.buildFingerprint}
@{ok=$true;status='RELEASE_V3_HOST_READINESS';activationReady=(@($checks | Where-Object {-not $_.passed}).Count -eq 0);checks=$checks.ToArray();runtime_mutated=$false} | ConvertTo-Json -Depth 8
