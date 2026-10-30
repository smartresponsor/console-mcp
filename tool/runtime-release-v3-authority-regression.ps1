$ErrorActionPreference='Stop'
if(-not $IsWindows -or [Diagnostics.Process]::GetCurrentProcess().SessionId -le 0){throw 'Managed interactive Windows fixture required'}
. (Join-Path $PSScriptRoot 'test-fixture.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/86-release-v3-store.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-v3-authority.ps1')
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
 @{ok=$true;status='RELEASE_V3_AUTHORITY_PASSED';session=$script:fixtureBroker.windows_session_id;dpapi=$true;privateAcl=$true;productionChanged=$false;retainedPrivateFixtureAuthority=$directory} | ConvertTo-Json
} finally {Remove-ConsoleTestFixture $Root}
