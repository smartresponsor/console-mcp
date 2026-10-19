$ErrorActionPreference = 'Stop'
$agent = (Resolve-Path (Join-Path $PSScriptRoot '../ops/ubuntu/script/desktop-session-agent.py')).Path
$test = @'
import importlib.util, os, sys
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('desktop_agent', sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
baseline = {'Id':'test-session','Name':'alex','Active':'yes','LockedHint':'no'}
for label, change, expected in [('active',{},True),('locked',{'LockedHint':'yes'},False),('inactive',{'Active':'no'},False)]:
    with patch.object(mod, 'session', return_value={**baseline, **change}), patch.dict(os.environ, {'DISPLAY':':0'}):
        result = mod.handle({'version':1,'operation':'status','requestId':'contract-test'})
        assert result['ok'] is expected, (label,result)
        assert not result['visibility_verified'] and not result['user_interaction_ready']
for fields in [{'operation':'exec','command':'id'}, {'operation':'verify','targetId':'http://127.0.0.1:9223'}, {'operation':'status','path':'/etc/shadow'}]:
    with patch.object(mod, 'session', return_value=baseline), patch.dict(os.environ, {'DISPLAY':':0'}), patch.object(mod.subprocess,'check_output') as execute:
        try:
            mod.handle({'version':1,'requestId':'contract-test',**fields})
        except ValueError:
            pass
        else:
            raise AssertionError('Unrecognized operation accepted')
        execute.assert_not_called()
print('DESKTOP_AGENT_CONTRACT_GREEN')
'@
& python3 -c $test $agent
if ($LASTEXITCODE -ne 0) { throw 'Desktop agent contract failed' }
