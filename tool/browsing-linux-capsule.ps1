$ErrorActionPreference='Stop'
& /usr/bin/node (Join-Path $PSScriptRoot 'browsing-linux-capsule.mjs')
exit $LASTEXITCODE
