$ErrorActionPreference = 'Stop'
& /usr/bin/node tool/nellis-readonly-probe.mjs
if ($LASTEXITCODE -ne 0) { throw "Nellis probe failed: $LASTEXITCODE" }
