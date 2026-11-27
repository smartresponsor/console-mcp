$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
& node (Join-Path $root 'tool/chat-prompt-screenshot-projection-regression.mjs')
exit $LASTEXITCODE
