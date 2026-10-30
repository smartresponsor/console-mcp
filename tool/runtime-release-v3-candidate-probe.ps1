[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$CandidatePath,[Parameter(Mandatory=$true)][string]$ControlRoot)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'test-fixture.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/70-smoke.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/89-release-v3-runtime.ps1')
function Get-NodeCommand {Get-Command node}
$fixture=New-ConsoleTestFixture -Prefix 'release-candidate-probe'
$Root=$CandidatePath;$child=$null
try {
 $null=[IO.Directory]::CreateDirectory((Join-Path $fixture 'policy'))
 $policyHashes=[ordered]@{}
 foreach($name in @('allowed-root.json','denied-path.json','allowed-check.json')){
  $from=Join-Path $ControlRoot ('policy/'+$name);$to=Join-Path $fixture ('policy/'+$name)
  [IO.File]::Copy($from,$to,$false);$policyHashes[$name]=(Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash
 }
 $reservation=$null
 for($attempt=0;$attempt -lt 30;$attempt++){
  $port=[Security.Cryptography.RandomNumberGenerator]::GetInt32(49152,65000)
  try{$reservation=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$port);$reservation.Start();break}catch{$reservation=$null}
 }
 if(-not $reservation){throw 'No isolated candidate probe port'}
 $reservation.Stop()
 $secret=[guid]::NewGuid().ToString('N')
 $info=[Diagnostics.ProcessStartInfo]::new((Get-Command node).Source)
 $info.ArgumentList.Add((Join-Path $CandidatePath 'dist/index.js'))
 $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.WorkingDirectory=$fixture
 $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
 foreach($pair in @{
  CONSOLE_MCP_AUTH_MODE='bearer';CONSOLE_MCP_HOST='127.0.0.1';CONSOLE_MCP_PORT=[string]$port;
  CONSOLE_MCP_BEARER_TOKEN=$secret;CONSOLE_MCP_MANAGED_RUNTIME='smoke-test';
  CONSOLE_MCP_WORKSPACE_ROOT=(Split-Path -Parent (Split-Path -Parent $ControlRoot));
  CONSOLE_MCP_RELEASE_PROBE='1';CONSOLE_MCP_TRANSCRIPT_DIR=(Join-Path $fixture 'transcript')
 }.GetEnumerator()){$info.Environment[$pair.Key]=$pair.Value}
 # Probe the actual provider generation, not a substitute worker or authenticated profile.
 $browse=Join-Path (Split-Path -Parent $ControlRoot) 'Browsing'
 $definitions=Join-Path $browse 'mcp-server/src/web-domain-tool-definitions.cjs'
 $worker=Join-Path $browse 'playwright-worker/src/worker.js'
 if(Test-Path -LiteralPath $definitions){$info.Environment['BROWSER_MCP_CORE_DOMAIN_DEFINITIONS_PATH']=$definitions}
 if(Test-Path -LiteralPath $worker){$info.Environment['CONSOLE_MCP_BROWSER_WORKER_SOURCE']=$worker}
 $child=[Diagnostics.Process]::Start($info)
 $stdout=$child.StandardOutput.ReadToEndAsync();$stderr=$child.StandardError.ReadToEndAsync()
 $deadline=[datetime]::UtcNow.AddSeconds(30);$connected=$false
 do{
  if($child.HasExited){throw 'Candidate exited before authenticated probe'}
  try{$response=Invoke-WebRequest -Uri "http://127.0.0.1:$port/mcp" -SkipHttpErrorCheck -TimeoutSec 1;$connected=$response.StatusCode -eq 401}catch{}
  if(-not $connected){Start-Sleep -Milliseconds 100}
 }while(-not $connected -and [datetime]::UtcNow -lt $deadline)
 if(-not $connected){throw 'Candidate probe did not bind its isolated port'}
 $smoke=Invoke-NodeMcpSmoke -Origin "http://127.0.0.1:$port" -WorkspacePath $ControlRoot -BearerToken $secret -TimeoutSeconds 30
 if(-not $smoke.ok){throw ('Candidate authenticated MCP probe failed: '+$smoke.stage+' '+$smoke.error)}
 $h=$smoke.health
 $health=if($h.structuredContent){$h.structuredContent}else{$h.content[0].text | ConvertFrom-Json}
 $fingerprint=Get-ReleaseV3BuildFingerprint $CandidatePath
 if(-not $health.ok -or $health.pid -ne $child.Id -or $health.buildFingerprint -cne $fingerprint){throw 'Candidate probe build/identity mismatch'}
 foreach($name in $policyHashes.Keys){if((Get-FileHash -LiteralPath (Join-Path $ControlRoot ('policy/'+$name)) -Algorithm SHA256).Hash -cne $policyHashes[$name]){throw 'Host policy changed during probe'}}
 @{ok=$true;status='RELEASE_CANDIDATE_HOST_CONFIG_PASSED';fingerprint=$fingerprint;registry=$health.canonicalRegistryFingerprint;hostPolicyHashes=$policyHashes;productionChanged=$false} | ConvertTo-Json -Depth 5
}finally{
 if($child){if(-not $child.HasExited){$child.Kill();$child.WaitForExit()};$child.Dispose()}
 Remove-ConsoleTestFixture $fixture
}
