$ErrorActionPreference='Stop'
$lines = @(& systemctl --user --machine=alex@.host show console-mcp-visible-edge.service -p ActiveState -p MainPID -p FragmentPath --no-pager 2>&1)
$exit = $LASTEXITCODE
[pscustomobject]@{ok=($exit -eq 0); status=if($exit -eq 0){'USER_MANAGER_ACCESSIBLE'}else{'USER_MANAGER_AUTH_REQUIRED'};exitCode=$exit;details=(@($lines | Select-Object -First 3) -join ' ')} | ConvertTo-Json -Compress
