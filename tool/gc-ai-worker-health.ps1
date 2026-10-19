$ErrorActionPreference='Stop'
foreach($port in @(8791,8793)){try{$r=Invoke-WebRequest -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 5 -SkipHttpErrorCheck;Write-Output ("PORT=$port HTTP="+[int]$r.StatusCode+" BODY="+($r.Content|Out-String).Substring(0,[Math]::Min(220,($r.Content|Out-String).Length)))}catch{Write-Output ("PORT=$port ERROR="+$_.Exception.GetType().Name)}}
