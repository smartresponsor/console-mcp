$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$names = @('preservation_bundle.py','preservation_ipc.py','preservation_hardened.py','preservation_activation.py','preservation_identity.py','preservation_server_v3.py','collector_windows.py')
$hashes = [ordered]@{}
foreach ($name in $names) { $hashes[$name] = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $PSScriptRoot $name)).Hash.ToLowerInvariant() }
if ($hashes['collector_windows.py'] -ne '3e628164666375ed278b543e0914758599e989c96650ab3be20f3923697c73b2') { throw 'COLLECTOR_HASH_MISMATCH' }
$manifest = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'm5-manifest.json') | ConvertFrom-Json -AsHashtable
if ($manifest.Count -ne $hashes.Count) { throw 'MANIFEST_COUNT_MISMATCH' }
foreach ($name in $names) { if ($manifest[$name] -cne $hashes[$name]) { throw "MANIFEST_HASH_MISMATCH: $name expected=$($manifest[$name]) actual=$($hashes[$name])" } }
$hashes | ConvertTo-Json -Compress
& id
Write-Output ('IPC_CONFIG_PRESENT=' + [bool]$env:CONSOLE_MCP_PRESERVATION_SOCKET)
& python3 -B -c "import ast,pathlib; [ast.parse(p.read_bytes(), filename=str(p)) for pattern in ('preservation*.py','m5-cross*.py') for p in pathlib.Path('tool').glob(pattern)]; print('PYTHON_PARSE_PASS')"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& npm run typecheck
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tool/m5-provider-policy-regression.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& python3 -B tool/test_preservation_baseline.py
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($IsLinux -and ((& /usr/bin/id -u) -ne '1000' -or [bool]$env:CONSOLE_MCP_PRESERVATION_SOCKET)) {
    Write-Output 'NATIVE_RECOVERY_AND_COMPLETION_OWNER_CONTEXT_REQUIRED'
    exit 78
}
& node tool/cmcp-go-completion-stability-regression.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node tool/engine-baseline-recovery-regression.mjs
exit $LASTEXITCODE
