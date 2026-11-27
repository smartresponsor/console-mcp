$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
& node --experimental-strip-types (Join-Path $root 'tool/chat-prompt-screenshot-regression.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node --experimental-strip-types (Join-Path $root 'tool/chat-prompt-screenshot-execution-regression.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node --experimental-strip-types (Join-Path $root 'tool/chat-prompt-screenshot-target-regression.mjs')
exit $LASTEXITCODE
