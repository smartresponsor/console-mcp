$ErrorActionPreference = 'Stop'
& npm run build
if ($LASTEXITCODE -ne 0) { throw 'Desktop client build failed' }
& node tool/desktop-session-client-regression.mjs
if ($LASTEXITCODE -ne 0) { throw 'Desktop client regression failed' }
