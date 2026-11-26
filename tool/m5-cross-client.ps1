param([Parameter(Mandatory=$true)][string]$SocketPath)
$ErrorActionPreference = 'Stop'
if ((& /usr/bin/id -u) -ne '993') { throw 'SERVICE_UID_REQUIRED' }
& /usr/bin/python3 -I -B (Join-Path $PSScriptRoot 'm5-cross-client.py') $SocketPath
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node (Join-Path $PSScriptRoot 'm6-engine-cross-client.mjs') $SocketPath
exit $LASTEXITCODE
