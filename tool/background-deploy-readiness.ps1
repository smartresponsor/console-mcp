$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$compiled=Join-Path $root 'dist/service/visible-browser-session.js'
$guard=Join-Path $root 'dist/service/visible-browser-tools.js'
$agent=Join-Path $root 'ops/ubuntu/script/desktop-session-agent.py'
$checks=[ordered]@{compiledBackground=(Test-Path $compiled) -and [bool](Select-String -LiteralPath $compiled -Pattern 'verify-background' -SimpleMatch -Quiet);guardBackground=(Test-Path $guard) -and [bool](Select-String -LiteralPath $guard -Pattern 'backgroundWebTools' -SimpleMatch -Quiet);agentSourceBackground=(Test-Path $agent) -and [bool](Select-String -LiteralPath $agent -Pattern 'verify-background' -SimpleMatch -Quiet)}
$checks | ConvertTo-Json -Compress
