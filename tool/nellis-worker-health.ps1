$ErrorActionPreference='Stop'
$rows=foreach($port in @(8791,8793,8795)){try{$r=Invoke-WebRequest -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 3 -SkipHttpErrorCheck;[pscustomobject]@{port=$port;status=[int]$r.StatusCode;body=$r.Content.Substring(0,[Math]::Min(250,$r.Content.Length))}}catch{[pscustomobject]@{port=$port;status='DOWN';reason=$_.Exception.GetType().Name}}}
$rows | ConvertTo-Json -Compress
