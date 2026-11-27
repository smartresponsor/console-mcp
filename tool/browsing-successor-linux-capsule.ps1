$ErrorActionPreference='Stop'
& /usr/bin/node (Join-Path $PSScriptRoot 'browsing-successor-linux-capsule.mjs')
exit $LASTEXITCODE
