[CmdletBinding()]
param([string]$FixtureRoot='', [string]$Mode='suite', [string]$CrashAt='')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/86-release-v3-store.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/87-release-v3-engine.ps1')
$owned=$false
if(-not $FixtureRoot){$FixtureRoot=Join-Path ([IO.Path]::GetTempPath()) ('release-v3-test-'+[guid]::NewGuid().ToString('N'));$owned=$true}
$null=[IO.Directory]::CreateDirectory($FixtureRoot)
$directory=Join-Path $FixtureRoot 'authority'
$model=Join-Path $FixtureRoot 'model.json'
$key=[byte[]](1..32)
$broker=@{generation='generation-1';login_epoch='login-1';session=7}
$candidate=@{entry='candidate';sha=('a'*40)};$previous=@{entry='previous';sha=('b'*40)}
function Read-Model {Get-Content -Raw -LiteralPath $model | ConvertFrom-Json -AsHashtable}
function Save-Model($m){Write-ReleaseV3Atomic $model ([Text.Encoding]::UTF8.GetBytes(($m | ConvertTo-Json -Compress)))}
$operations=@{
 Validate={param($d) if($d.entry -notin @('candidate','previous')){throw 'Bad descriptor'}}
 Observe={param($c,$p,$t) $m=Read-Model;@{kind=$m.kind;identity=$m.identity}}
 Gate={param($s) if(Test-Path (Join-Path $FixtureRoot 'gate-fail')){throw 'Gate refused'}}
 Stop={param($i) $m=Read-Model;if(Test-Path (Join-Path $FixtureRoot 'stop-fail')){throw 'Stop refused'};if($i.pid -ne $m.identity.pid){throw 'Identity drift'};Save-Model @{kind='empty';identity=$null};if($CrashAt -eq 'stop'){[Environment]::Exit(73)}}
 Start={param($d,$t)
  if(Test-Path (Join-Path $FixtureRoot ($d.entry+'-fail'))){throw 'Start failed'}
  $identity=@{pid=if($d.entry -eq 'candidate'){202}else{303};started=$t;entry=$d.entry}
  Save-Model @{kind=$d.entry;identity=$identity}
  if($CrashAt -eq 'start'){[Environment]::Exit(73)}
  return $identity
 }
 Verify={param($d,$i) if(Test-Path (Join-Path $FixtureRoot ($d.entry+'-health-fail'))){throw 'Health failed'};if($CrashAt -eq 'verify' -and $d.entry -eq 'candidate'){[Environment]::Exit(73)}}
}
function Invoke-TestTransaction([string]$op,[string]$id){Invoke-ReleaseV3 $directory $key $broker $op $id $candidate $previous $operations}
function New-Case {
 $script:directory=Join-Path $FixtureRoot ([guid]::NewGuid().ToString('N'))
 Save-Model @{kind='previous';identity=@{pid=101;started='old';entry='previous'}}
 $script:id=[guid]::NewGuid().ToString('N')
 $null=Invoke-TestTransaction 'prepare' $id
}
function Assert($condition,[string]$message){if(-not $condition){throw $message}}
if($Mode -eq 'hold-lock'){
 $lock=Open-ReleaseV3Lock $directory
 try {Set-Content (Join-Path $FixtureRoot 'locked') 'ready';Start-Sleep -Seconds 30} finally {$lock.Dispose()}
 exit
}
if($Mode -eq 'crash'){
 $directory=(Get-Content (Join-Path $FixtureRoot 'case-directory') -Raw).Trim()
 $prepared=Read-ReleaseV3Signed (Join-Path $directory 'transaction.json') $key
 $id=$prepared.id; $broker=$prepared.broker
 $null=Invoke-TestTransaction 'activate' $id
 throw 'Expected process interruption did not occur'
}
$cases=[Collections.Generic.List[string]]::new()
try {
 Assert ((Invoke-TestTransaction 'status' '').phase -eq 'NO_TRANSACTION') 'Empty authority status was ambiguous'
 try{$null=Invoke-TestTransaction 'activate' ([guid]::NewGuid().ToString('N'));throw 'Activation without prepare accepted'}catch{Assert ($_.Exception.Message -eq 'RELEASE_TRANSACTION_NOT_PREPARED') 'Empty activation not refused'}
 $cases.Add('empty-authority-status')
 New-Case
 $state=Invoke-TestTransaction 'activate' $id
 Assert ($state.phase -eq 'COMMITTED') 'Activation failed'
 Assert ((Invoke-TestTransaction 'activate' $id).receipts.Count -eq $state.receipts.Count) 'Duplicate activation executed'
 Assert ((Read-ReleaseV3Signed (Join-Path $directory 'selected.json') $key).release.entry -eq 'candidate') 'Selection not durable'
 Assert ((Invoke-TestTransaction 'rollback' $id).phase -eq 'ROLLED_BACK') 'Explicit rollback failed'
 $cases.Add('activation-idempotency-and-explicit-rollback')
 New-Case;Set-Content (Join-Path $FixtureRoot 'stop-fail') 'fail'
 Assert ((Invoke-TestTransaction 'activate' $id).phase -eq 'ROLLED_BACK') 'Retained incumbent failed verification'
 Assert ((Read-Model).identity.pid -eq 101 -and -not (Test-Path (Join-Path $directory 'selected.json'))) 'Failed stop changed selection or incumbent'
 Remove-Item (Join-Path $FixtureRoot 'stop-fail');$cases.Add('stop-refusal-preserves-existing-selection')
 New-Case;$broker.generation='stale'
 try{$null=Invoke-TestTransaction 'activate' $id;throw 'Stale broker accepted'}catch{Assert ($_.Exception.Message -eq 'RELEASE_STALE_BROKER') 'Stale broker not refused'}
 Assert ((Read-Model).identity.pid -eq 101) 'Stale broker touched incumbent'
 $broker.generation='generation-1';$cases.Add('stale-broker-before-stop')
 New-Case;Save-Model @{kind='empty';identity=$null}
 Assert ((Invoke-TestTransaction 'recover' $id).phase -eq 'ROLLED_BACK') 'Prepared-only recovery did not restore missing incumbent'
 $cases.Add('prepared-only-storage-recovery')
 foreach($failure in @('candidate-fail','candidate-health-fail')){
  New-Case; Set-Content (Join-Path $FixtureRoot $failure) 'fail'
  Assert ((Invoke-TestTransaction 'activate' $id).phase -eq 'ROLLED_BACK') $failure
  Remove-Item -LiteralPath (Join-Path $FixtureRoot $failure)
  $cases.Add($failure)
 }
 New-Case;Set-Content (Join-Path $FixtureRoot 'candidate-health-fail') 'fail';Set-Content (Join-Path $FixtureRoot 'previous-fail') 'fail'
 Assert ((Invoke-TestTransaction 'activate' $id).phase -eq 'RECOVERY_REQUIRED') 'Rollback failure falsely succeeded'
 Remove-Item (Join-Path $FixtureRoot 'candidate-health-fail'),(Join-Path $FixtureRoot 'previous-fail')
 $broker.generation='replacement-broker'
 Assert ((Invoke-TestTransaction 'recover' $id).phase -eq 'ROLLED_BACK') 'Recovery under new broker failed'
 $cases.Add('rollback-failure-and-new-generation-recovery')
 foreach($point in @('stop','start','verify')){
  New-Case
  Set-Content (Join-Path $FixtureRoot 'case-directory') $directory
  $launch=@{FilePath=(Get-Command pwsh).Source;ArgumentList=@('-NoProfile','-File',('"'+$PSCommandPath+'"'),'-FixtureRoot',('"'+$FixtureRoot+'"'),'-Mode','crash','-CrashAt',$point);PassThru=$true}
  if($IsWindows){$launch.WindowStyle='Hidden'}
  $child=Start-Process @launch
  if(-not $child.WaitForExit(30000)){$child.Kill();throw 'Interrupted fixture timed out'}
  Assert ($child.ExitCode -eq 73) 'Fixture did not interrupt actual process'
  Assert ((Invoke-TestTransaction 'recover' $id).phase -eq 'ROLLED_BACK') ('Interrupted '+$point+' recovery failed')
  $cases.Add('process-interrupted-'+$point)
 }
 New-Case;Set-Content (Join-Path $FixtureRoot 'gate-fail') 'fail'
 try {$null=Invoke-TestTransaction 'activate' $id;throw 'Gate accepted'}catch{Assert ($_.Exception.Message -eq 'Gate refused') 'Unexpected gate result'}
 Assert ((Read-Model).kind -eq 'previous') 'Gate touched incumbent'
 Remove-Item (Join-Path $FixtureRoot 'gate-fail');$cases.Add('gate-refusal-before-stop')
 $tampered=Get-Content (Join-Path $directory 'transaction.json') -Raw | ConvertFrom-Json -AsHashtable
 $tampered.mac='0'*64;Set-Content (Join-Path $directory 'transaction.json') ($tampered | ConvertTo-Json -Compress)
 try {$null=Invoke-TestTransaction 'recover' $id;throw 'Tamper accepted'}catch{Assert ($_.Exception.Message -eq 'RELEASE_RECEIPT_AUTHENTICATION_FAILED') 'Tamper not rejected'}
 $cases.Add('authenticated-journal-tamper-refusal')
 $directory=Join-Path $FixtureRoot 'authority'
 $launch=@{FilePath=(Get-Command pwsh).Source;ArgumentList=@('-NoProfile','-File',('"'+$PSCommandPath+'"'),'-FixtureRoot',('"'+$FixtureRoot+'"'),'-Mode','hold-lock');PassThru=$true}
 if($IsWindows){$launch.WindowStyle='Hidden'}
 $child=Start-Process @launch
 try {
  $deadline=[datetime]::UtcNow.AddSeconds(15)
  while(-not (Test-Path (Join-Path $FixtureRoot 'locked')) -and [datetime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 50}
  Assert (Test-Path (Join-Path $FixtureRoot 'locked')) 'Concurrent fixture not ready'
  try {$null=Invoke-TestTransaction 'prepare' ([guid]::NewGuid().ToString('N'));throw 'Concurrent writer accepted'}catch{Assert ($_.Exception.Message -eq 'RELEASE_TRANSACTION_BUSY') 'Concurrent writer did not fail closed'}
 } finally {if(-not $child.HasExited){$child.Kill();$child.WaitForExit()}}
 $cases.Add('cross-process-single-writer')
 @{ok=$true;status='RELEASE_V3_REGRESSION_PASSED';cases=$cases.ToArray();productionChanged=$false} | ConvertTo-Json -Depth 5
} finally {
 if($owned){
  $resolved=[IO.Path]::GetFullPath($FixtureRoot)
  if([IO.Path]::GetFileName($resolved) -notmatch '^release-v3-test-[0-9a-f]{32}$' -or [IO.Path]::GetDirectoryName($resolved).TrimEnd('\','/') -ine ([IO.Path]::GetTempPath()).TrimEnd('\','/')){throw 'Fixture cleanup boundary failed'}
  if(@(Get-ChildItem -LiteralPath $resolved -Recurse -Force | Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count){throw 'Fixture contains reparse point; preserved'}
  [IO.Directory]::Delete($resolved,$true)
 }
}
