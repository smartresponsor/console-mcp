$ErrorActionPreference = 'Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
  & node tool/visible-browser-session-regression.mjs
  if ($LASTEXITCODE -ne 0) { throw "Visible browser regression failed: $LASTEXITCODE" }
} finally { Pop-Location }
