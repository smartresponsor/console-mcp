# Exercises read-only status decisions without starting the desktop agent.
$ErrorActionPreference = 'Stop'
$agent = (Resolve-Path (Join-Path $PSScriptRoot '../ops/ubuntu/script/desktop-session-agent.py')).Path
$test = @'
import importlib.util, json, os, sys
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("desktop_session_agent", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
baseline = "Active=yes\nRemote=no\nClass=user\nName=alex\nLockedHint=no\nType=x11\n"
cases = [
    ("active", baseline, True),
    ("locked", baseline.replace("LockedHint=no", "LockedHint=yes"), False),
    ("remote", baseline.replace("Remote=no", "Remote=yes"), False),
    ("wrong-user", baseline.replace("Name=alex", "Name=other"), False),
    ("non-graphical", baseline.replace("Type=x11", "Type=tty"), False),
]
for name, response, expected in cases:
    env = {"XDG_SESSION_ID":"2", "USER":"alex", "DISPLAY":":0"}
    with patch.dict(os.environ, env, clear=True), patch.object(os, "geteuid", return_value=1000), patch.object(mod.subprocess, "check_output", return_value=response):
        state = mod.status()
    assert state["ok"] is expected, (name, state)
    assert state["visibility_verified"] is False, name
    assert state["user_interaction_ready"] is False, name
with patch.dict(os.environ, {"USER":"alex", "DISPLAY":":0"}, clear=True):
    assert mod.status()["ok"] is False
print("DESKTOP_AGENT_DECISION_TESTS_GREEN")
'@
& python3 -c $test $agent
if ($LASTEXITCODE -ne 0) { throw 'Desktop session decision regression failed' }
