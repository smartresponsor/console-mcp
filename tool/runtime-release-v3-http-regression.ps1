$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'test-fixture.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/86-release-v3-store.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/87-release-v3-engine.ps1')
$fixture=New-ConsoleTestFixture -Prefix 'release-v3-http'
$directory=Join-Path $fixture 'authority';$key=[Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
$broker=@{generation='http-fixture';login_epoch='test';session=1}
$reservation=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$reservation.Start();$port=$reservation.LocalEndpoint.Port;$reservation.Stop()
if($port -in @(3333,3334,3335,8791,8793,8795,8797,9223,9224,9230)){throw 'Protected fixture port'}
$token=[guid]::NewGuid().ToString('N');$owned=@{};$script:current=$null
$entry=Join-Path $fixture 'runtime.mjs'
@'
import http from 'node:http';
const server=http.createServer((req,res)=>{
 if(req.headers.authorization!==`Bearer ${process.env.FIXTURE_TOKEN}`){res.writeHead(401);res.end();return;}
 if(process.argv[2]==='hang' && req.url==='/mcp'){res.setHeader('Content-Type','text/event-stream');res.write(': waiting\n\n');return;}
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,pid:process.pid,version:process.argv[2]}));
});
server.listen(Number(process.argv[3]),'127.0.0.1');
'@ | Set-Content -LiteralPath $entry
$sentinel=Join-Path $fixture 'user-session-data';[IO.File]::WriteAllText($sentinel,'credentials-and-profile-sentinel')
$candidate=@{entry=$entry;sha='new';kind='candidate'};$previous=@{entry=$entry;sha='old';kind='previous'}
function Get-FixtureHealth {
 try{return Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -Headers @{Authorization=('Bearer '+$token)} -TimeoutSec 2}catch{return $null}
}
function Start-FixtureRuntime($d,$t){
 $info=[Diagnostics.ProcessStartInfo]::new((Get-Command node).Source)
 $info.ArgumentList.Add($d.entry);$info.ArgumentList.Add($d.sha);$info.ArgumentList.Add([string]$port)
 $info.WorkingDirectory=$fixture;$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.Environment['FIXTURE_TOKEN']=$token
 $child=[Diagnostics.Process]::Start($info);$owned[$child.Id]=$child
 $script:current=[ordered]@{pid=$child.Id;started=$child.StartTime.ToUniversalTime().ToString('o');kind=$d.kind}
 $until=[datetime]::UtcNow.AddSeconds(10)
 do{$h=Get-FixtureHealth;if($h -and $h.pid -eq $child.Id){return $script:current};Start-Sleep -Milliseconds 50}while([datetime]::UtcNow -lt $until -and -not $child.HasExited)
 throw 'Fixture startup failed'
}
$operations=@{
 Validate={param($d) if($d.entry -cne $entry){throw 'Unexpected fixture entry'}}
 Observe={param($c,$p,$t) $h=Get-FixtureHealth;if(-not $h){return @{kind='empty';identity=$null}};if(-not $owned.ContainsKey([int]$h.pid)){return @{kind='foreign';identity=$null}};@{kind=$script:current.kind;identity=$script:current}}
 Stop={param($i) $p=$owned[[int]$i.pid];if(-not $p -or $p.StartTime.ToUniversalTime().ToString('o') -cne $i.started){throw 'Fixture identity drift'};$p.Kill();$p.WaitForExit();$script:current=$null}
 Start={param($d,$t) Start-FixtureRuntime $d $t}
 Verify={param($d,$i) $h=Get-FixtureHealth;if(-not $h -or $h.pid -ne $i.pid -or $h.version -cne $d.sha -or ($script:failHealth -and $d.kind -eq 'candidate')){throw 'Authenticated fixture health failed'}}
 Gate={param($s) if([IO.File]::ReadAllText($sentinel) -cne 'credentials-and-profile-sentinel'){throw 'State changed'}}
}
function Invoke-HttpTransaction($operation,$id){Invoke-ReleaseV3 $directory $key $broker $operation $id $candidate $previous $operations}
try {
 $null=Start-FixtureRuntime $previous 'old'
 $id=[guid]::NewGuid().ToString('N');$null=Invoke-HttpTransaction 'prepare' $id
 if((Invoke-HttpTransaction 'activate' $id).phase -ne 'COMMITTED'){throw 'Real activation failed'}
 $unauthorized=Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -SkipHttpErrorCheck -TimeoutSec 2
 if($unauthorized.StatusCode -ne 401){throw 'Fixture authentication lost'}
 if((Invoke-HttpTransaction 'rollback' $id).phase -ne 'ROLLED_BACK'){throw 'Real rollback failed'}
 $id=[guid]::NewGuid().ToString('N');$null=Invoke-HttpTransaction 'prepare' $id;$script:failHealth=$true
 if((Invoke-HttpTransaction 'activate' $id).phase -ne 'ROLLED_BACK'){throw 'Real health failure did not roll back'}
 $script:failHealth=$false
 $id=[guid]::NewGuid().ToString('N');$state=Invoke-HttpTransaction 'prepare' $id
 # Persist the same crash point as a controller lost after the confirmed stop.
 $lock=Open-ReleaseV3Lock $directory
 try{
  Add-ReleaseV3Receipt $state 'STOPPING' $script:current (Join-Path $directory 'transaction.json') $key $broker
  & $operations.Stop $script:current
  Add-ReleaseV3Receipt $state 'STOPPED' @{kind='empty'} (Join-Path $directory 'transaction.json') $key $broker
 }finally{$lock.Dispose()}
 $broker.generation='http-recovery'
 if((Invoke-HttpTransaction 'recover' $id).phase -ne 'ROLLED_BACK'){throw 'Real recovery failed'}
 if((Get-FixtureHealth).version -cne 'old' -or [IO.File]::ReadAllText($sentinel) -cne 'credentials-and-profile-sentinel'){throw 'State/auth preservation failed'}
 & $operations.Stop $script:current
 $null=Start-FixtureRuntime @{entry=$entry;sha='hang';kind='candidate'} 'hang-probe'
 . (Join-Path $PSScriptRoot 'dev-console.d/70-smoke.ps1')
 function Get-NodeCommand {Get-Command node}
 $Root=Split-Path -Parent $PSScriptRoot
 $clock=[Diagnostics.Stopwatch]::StartNew()
 $probe=Invoke-NodeMcpSmoke -Origin "http://127.0.0.1:$port" -WorkspacePath $Root -BearerToken $token -TimeoutSeconds 5
 if($probe.ok -or $probe.stage -cne 'SMOKE_DEADLINE' -or $clock.Elapsed.TotalSeconds -gt 12){throw 'Authenticated health deadline not enforced'}
 @{ok=$true;status='RELEASE_V3_AUTHENTICATED_HTTP_PASSED';cases=5;productionChanged=$false} | ConvertTo-Json
}finally{
 foreach($child in $owned.Values){if(-not $child.HasExited){$child.Kill();$child.WaitForExit()};$child.Dispose()}
 Remove-ConsoleTestFixture $fixture
}
