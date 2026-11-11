$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$cursor=$root;$found=$null
for($d=0;$d -lt 6 -and $cursor;$d++){
 $candidate=Join-Path $cursor 'AwsSecretContract/tool/secret-runtime.ps1'
 if(Test-Path -LiteralPath $candidate -PathType Leaf){$found=$candidate;break}
 $next=Split-Path -Parent $cursor;if($next -eq $cursor){break};$cursor=$next
}
$meta=$null
if($found){$file=Get-Item -LiteralPath $found -Force;$meta=[pscustomobject]@{exists=$true;isLink=[bool]$file.LinkType;size=$file.Length;rootAccessible=[bool](Test-Path -LiteralPath (Split-Path -Parent $found))}}
$service=@(& /usr/bin/systemctl show console-mcp.service -p User -p MainPID -p EnvironmentFiles -p Environment --no-pager)
$safeService=[ordered]@{}
foreach($line in $service){if($line -match '^([^=]+)=(.*)$'){$name=$Matches[1];$value=$Matches[2];if($name -eq 'Environment'){ $safeService[$name]=[bool]($value -match 'CONSOLE_MCP_BEARER_TOKEN|AWS_REGION|AWS_PROFILE') } elseif($name -eq 'EnvironmentFiles'){ $safeService[$name]=[bool]($value -ne '') } else {$safeService[$name]=$value}}}
[pscustomobject]@{status='SECRET_BOOTSTRAP_CONTRACT_AUDIT';sharedRuntime=$meta;sharedRuntimeFound=[bool]$found;bootstrapWouldRun=[bool]$found;service=$safeService;secretLoaded=$false;runtimeInvoked=$false} | ConvertTo-Json -Depth 5 -Compress
