$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/86-release-v3-store.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/84-release-v3-seal-request.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/80-release-v3-sealer-auth.ps1')
$base=Join-Path ([IO.Path]::GetTempPath()) ('sealer-journal-test-'+[guid]::NewGuid().ToString('N'))
$script=Join-Path $PSScriptRoot 'release-sealer-journal-fixture.ps1'
$key=[byte[]](1..32)
$keyHex=[Convert]::ToHexString($key).ToLowerInvariant()
$null=[IO.Directory]::CreateDirectory($base)
function Invoke-Fixture([string]$op,[string]$json=''){
  $arguments=@('-NoProfile','-NonInteractive','-File',$script,'-FixtureDirectory',$base,'-Operation',$op,'-KeyHex',$keyHex)
  if($json){$arguments+=@('-RequestJson',$json)}
  $output=& pwsh @arguments 2>&1
  return @{exit=$LASTEXITCODE;output=($output|Out-String)}
}
try {
  $unmarked=Invoke-Fixture 'initialize'
  if($unmarked.exit -eq 0){throw 'UNMARKED_JOURNAL_ACCEPTED'}
  [IO.File]::WriteAllText((Join-Path $base '.console-mcp-sealer-journal-fixture'),'fixture')
  $init=Invoke-Fixture 'initialize'
  if($init.exit -ne 0){throw ('INITIALIZE_FAILED '+$init.output)}
  $duplicate=Invoke-Fixture 'initialize'
  if($duplicate.exit -eq 0){throw 'DUPLICATE_INITIALIZE_ACCEPTED'}
  $now=[datetimeoffset]::UtcNow
  $req=@{schema_version=1;operation='seal_new_release';request_id=('a'*32);source_sha=('b'*40);
    payload_inventory_sha256=('c'*64);release_id=('d'*40);rollback_release_id=('e'*40);
    expires_at=$now.AddMinutes(5).ToString('o');authority_mac=('0'*64)}
  $req.authority_mac=Get-ReleaseV3SealRequestMac -Request $req -Key $key
  $json=$req|ConvertTo-Json -Compress
  $reserve=Invoke-Fixture 'reserve' $json
  if($reserve.exit -ne 0 -or $reserve.output -notmatch 'SEAL_JOURNAL_FIXTURE_RESERVED'){throw ('RESERVE_FAILED '+$reserve.output)}
  $exclusive=Open-ReleaseV3Lock $base
  try {
    $contested=Invoke-Fixture 'inspect'
    if($contested.exit -eq 0){throw 'CONCURRENT_JOURNAL_ACCESS_ACCEPTED'}
  } finally {$exclusive.Dispose()}
  $inspect=Invoke-Fixture 'inspect'
  if($inspect.exit -ne 0 -or $inspect.output -notmatch '"records":1'){throw 'DURABLE_READBACK_MISSING'}
  $retry=Invoke-Fixture 'reserve' $json
  if($retry.exit -eq 0){throw 'DURABLE_REPLAY_ACCEPTED'}
  $other=$req.Clone();$other.request_id=('1'*32)
  $other.authority_mac=Get-ReleaseV3SealRequestMac -Request $other -Key $key
  $conflict=Invoke-Fixture 'reserve' ($other|ConvertTo-Json -Compress)
  if($conflict.exit -eq 0){throw 'DURABLE_RELEASE_COLLISION_ACCEPTED'}
  $wrongKey=[Convert]::ToHexString([byte[]](2..33)).ToLowerInvariant()
  $wrong=& pwsh -NoProfile -NonInteractive -File $script -FixtureDirectory $base -Operation inspect -KeyHex $wrongKey 2>&1
  if($LASTEXITCODE -eq 0){throw 'TAMPERED_KEY_ACCEPTED'}
  $journal=Join-Path $base 'sealer-replay.json'
  [IO.File]::AppendAllText($journal,'tamper')
  $tampered=Invoke-Fixture 'inspect'
  if($tampered.exit -eq 0){throw 'TAMPERED_JOURNAL_ACCEPTED'}
  'SEALER_JOURNAL_FIXTURE_REGRESSION_PASS'
} finally {
  if(Test-Path -LiteralPath $base){Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction Stop}
}
