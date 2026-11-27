$ErrorActionPreference='Stop'
& /usr/bin/python3 -I -B (Join-Path $PSScriptRoot 'legacy-ingress-bootstrap-audit.py')
if ($LASTEXITCODE -ne 0) { throw 'LEGACY_INGRESS_INVENTORY_FAILED' }
