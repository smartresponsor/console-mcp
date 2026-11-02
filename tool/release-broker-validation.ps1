$ErrorActionPreference = 'Stop'
& /usr/bin/python3 -I (Join-Path $PSScriptRoot '../ops/ubuntu/deployment/release-broker-regression.py')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node (Join-Path $PSScriptRoot 'console-tool-admission-projection-cli.mjs') --write
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node (Join-Path $PSScriptRoot 'validate-console-tool-catalog.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node (Join-Path $PSScriptRoot 'validate-capability-admission.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
