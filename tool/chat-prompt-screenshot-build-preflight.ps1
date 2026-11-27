$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = '/home/alex/smartresponse/mcp/console-mcp'
$baseline = '9e216178dd5a76b55bd1f9fd607f956041923ab3'
$expected = & git -C $source rev-parse "${baseline}:package-lock.json"
if ($LASTEXITCODE -ne 0) { throw 'LOCK_BASELINE_UNAVAILABLE' }
$actual = & git -C $source hash-object --no-filters (Join-Path $root 'package-lock.json')
if ($LASTEXITCODE -ne 0) { throw 'LOCK_HASH_UNAVAILABLE' }
if ($expected -ne $actual) { throw "LOCKFILE_CHANGED expected=$expected actual=$actual" }
Write-Output "LOCKFILE_UNCHANGED gitBlob=$actual"
& node (Join-Path $root 'tool/chat-prompt-screenshot-socket-regression.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node (Join-Path $root 'tool/chat-prompt-screenshot-admission-regression.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node (Join-Path $root 'tool/chat-prompt-screenshot-result-regression.mjs')
exit $LASTEXITCODE
