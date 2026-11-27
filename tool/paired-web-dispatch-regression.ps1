param([Parameter(Mandatory=$true)][string]$BrowsingRoot)
$ErrorActionPreference='Stop'
& /usr/bin/npm run build
if ($LASTEXITCODE -ne 0) { throw 'PAIRED_DISPATCH_BUILD_FAILED' }
& /usr/bin/node tool/paired-web-dispatch-regression.mjs $BrowsingRoot
if ($LASTEXITCODE -ne 0) { throw 'PAIRED_DISPATCH_FAILED' }
