$ErrorActionPreference='Stop'
$body='{"version":1,"operation":"verify","requestId":"nellis-bg-diagnostic","targetId":"B2BD3CA2B44993468A6AE2E6AAF18719"}'
'{"version":1,"operation":"status","requestId":"nellis-status-diagnostic"}' | & /usr/bin/python3 ops/ubuntu/script/desktop-agent-client.py
$body | & /usr/bin/python3 ops/ubuntu/script/desktop-agent-client.py
if($LASTEXITCODE -ne 0){throw 'Background verification diagnostic failed'}
