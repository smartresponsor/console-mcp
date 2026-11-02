$ErrorActionPreference='Stop'
if(-not $IsWindows -or [Diagnostics.Process]::GetCurrentProcess().SessionId -le 0){throw 'Managed interactive Windows fixture required'}
. (Join-Path $PSScriptRoot 'test-fixture.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/86-release-v3-store.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-v3-authority.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/89-release-v3-runtime.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/89-release-v3-control.ps1')
$script:sealed=@{entry='C:\sealed\dist\index.js';fingerprint='1234567890abcdef';files=@{'dist\index.js'='abc';'policy\allowed-check.json'='def'}}
$script:rollback=@{fingerprint='1234567890abcdef';files=@{'dist\index.js'='abc';'policy\allowed-check.json'='def'}}
$script:incumbent=@{pid=123;command='node.exe C:\sealed\dist\index.js --console-release-transaction=abc'}
$script:health=@{ok=$true;pid=123;buildFingerprint='1234567890abcdef'}
Assert-ReleaseV3SealedIncumbent -Selected $sealed -Rollback $rollback -Identity $incumbent -Health $health
foreach($case in @(
  @{selected=@{entry=$sealed.entry;fingerprint='changed';files=$sealed.files};rollback=$rollback;identity=$incumbent;health=$health;error='RELEASE_ROLLBACK_NOT_EXACT'},
  @{selected=$sealed;rollback=@{fingerprint=$rollback.fingerprint;files=@{'dist\index.js'='tampered';'policy\allowed-check.json'='def'}};identity=$incumbent;health=$health;error='RELEASE_ROLLBACK_CONTENT_MISMATCH'},
  @{selected=$sealed;rollback=$rollback;identity=@{pid=123;command='node.exe C:\foreign\dist\index.js'};health=$health;error='RELEASE_INCUMBENT_IDENTITY_MISMATCH'},
  @{selected=$sealed;rollback=$rollback;identity=$incumbent;health=@{ok=$true;pid=999;buildFingerprint=$health.buildFingerprint};error='RELEASE_LIVE_ROLLBACK_BUILD_MISMATCH'},
  @{selected=$sealed;rollback=$rollback;identity=$incumbent;health=@{ok=$true;pid=123;buildFingerprint='wrong'};error='RELEASE_LIVE_ROLLBACK_BUILD_MISMATCH'}
)){
  try {
    Assert-ReleaseV3SealedIncumbent -Selected $case.selected -Rollback $case.rollback -Identity $case.identity -Health $case.health
    throw 'Sealed rollback fixture incorrectly admitted'
  } catch {
    if($_.Exception.Message -cne $case.error){throw}
  }
}

$Root=New-ConsoleTestFixture -Prefix 'release-authority-test'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$script:fixtureBroker=@{pid=$PID;generation=[guid]::NewGuid().ToString('N');windows_session_id=[Diagnostics.Process]::GetCurrentProcess().SessionId;user_sid=$sid}
$script:fixtureBroker.code_fingerprint=Get-ReleaseV3BrokerCodeDigest
function Get-ServerControlBrokerIdentity {$script:fixtureBroker}
function Get-ConsoleSessionReport {@{active_console=@{id=[Diagnostics.Process]::GetCurrentProcess().SessionId}}}
try {
 $script:fixtureBroker.pid=0
 try{$null=Get-ReleaseV3Key;throw 'Foreign broker accepted'}catch{if($_.Exception.Message -ne 'RELEASE_INTERACTIVE_BROKER_REQUIRED'){throw}}
 $script:fixtureBroker.pid=$PID
 $key=Get-ReleaseV3Key
 if($key.Length -ne 32){throw 'Invalid key size'}
 $directory=Get-ReleaseV3Directory
 $value=@{fixture=$true;at=[datetimeoffset]::UtcNow.ToString('o')}
 $path=Join-Path $directory 'authority-test.json'
 Write-ReleaseV3Signed $path $value $key
 $read=Read-ReleaseV3Signed $path (Get-ReleaseV3Key -ReadOnly)
 if(-not $read.fixture -or $read.at -cne $value.at){throw 'DPAPI signed round trip failed'}
 $acl=Get-Acl -LiteralPath $directory
 if(-not $acl.AreAccessRulesProtected){throw 'Authority ACL inherited'}
 $launch=[guid]::NewGuid().ToString('N');$entry=Join-Path $Root 'dist/index.js'
 Write-ReleaseV3Signed (Join-Path $directory 'selected.json') @{schema=3;transaction=$launch;release=@{entry=$entry;launch_id=$launch}} $key
 $matcher=Get-ReleaseV3ProcessMatcher
 $command='C:\node.exe "'+$entry+'" --console-release-transaction='+$launch
 if($command -notmatch $matcher -or $command.Replace($launch,('0'*32)) -match $matcher -or 'C:\node.exe C:\foreign\dist\index.js' -match $matcher){throw 'Selected runtime matcher admitted a foreign process'}
 $null=[IO.Directory]::CreateDirectory((Join-Path $Root 'var/log'))
 $log=Join-Path $Root 'var/log/console-mcp-unified.log';[IO.File]::WriteAllText($log,'retained-fixture-log')
 Save-ReleaseV3RuntimeLogs $launch
 $archived=@(Get-ChildItem -LiteralPath (Join-Path $directory 'logs') -Recurse -File)
 if($archived.Count -ne 1 -or [IO.File]::ReadAllText($archived[0].FullName) -cne 'retained-fixture-log' -or [IO.File]::ReadAllText($log) -cne 'retained-fixture-log'){throw 'Runtime log preservation failed'}
 @{ok=$true;status='RELEASE_V3_AUTHORITY_PASSED';session=$script:fixtureBroker.windows_session_id;dpapi=$true;privateAcl=$true;productionChanged=$false;retainedPrivateFixtureAuthority=$directory} | ConvertTo-Json
} finally {Remove-ConsoleTestFixture $Root}
