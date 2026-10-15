# Static validation only; never starts the GUI agent or browser.
$ErrorActionPreference = 'Stop'
$agent = Join-Path $PSScriptRoot '../ops/ubuntu/script/desktop-session-agent.py'
$unit = Join-Path $PSScriptRoot '../ops/ubuntu/systemd/console-mcp-desktop-agent.service'
$python = @'
import ast, pathlib, sys
source = pathlib.Path(sys.argv[1]).read_text()
ast.parse(source)
assert 'SO_PEERCRED' in source
assert 'LOCK_EX | fcntl.LOCK_NB' in source
assert "'visibility_verified': False" in source
assert "'user_interaction_ready': False" in source
print("PYTHON_AGENT_STATIC_GREEN")
'@
& python3 -c $python $agent
if ($LASTEXITCODE -ne 0) { throw 'Python agent syntax or static contract failed' }
$originalRuntime = $env:XDG_RUNTIME_DIR
$staticRuntime = Join-Path ([IO.Path]::GetTempPath()) ('cmcp-static-unit-' + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $staticRuntime | Out-Null
    & chmod 0700 $staticRuntime
    $env:XDG_RUNTIME_DIR = $staticRuntime
    & systemd-analyze --user verify $unit
    if ($LASTEXITCODE -ne 0) { throw 'User unit validation failed' }
} finally {
    $env:XDG_RUNTIME_DIR = $originalRuntime
    Remove-Item -LiteralPath $staticRuntime -Recurse -Force
}
Write-Output 'DESKTOP_AGENT_VALIDATION_GREEN'
