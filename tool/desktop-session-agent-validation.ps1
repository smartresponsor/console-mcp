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
& systemd-analyze verify $unit
if ($LASTEXITCODE -ne 0) { throw 'User unit validation failed' }
Write-Output 'DESKTOP_AGENT_VALIDATION_GREEN'
