$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
& node (Join-Path $root 'tool/chat-prompt-screenshot-socket-regression.mjs') --live-readonly
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node (Join-Path $root 'tool/chat-prompt-screenshot-admission-regression.mjs') --live-readonly
exit $LASTEXITCODE
