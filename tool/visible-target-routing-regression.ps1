$ErrorActionPreference = 'Stop'
& /usr/bin/node tool/visible-target-routing-regression.mjs
if ($LASTEXITCODE -ne 0) { throw "Visible routing regression failed: $LASTEXITCODE" }
