param([Parameter(Mandatory=$true)][string]$SocketPath)
$ErrorActionPreference = 'Stop'
if ((& /usr/bin/id -u) -ne '993') { throw 'SERVICE_UID_REQUIRED' }
& /usr/bin/python3 -I -B (Join-Path $PSScriptRoot 'm5-cross-client.py') $SocketPath
exit $LASTEXITCODE
