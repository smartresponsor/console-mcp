$ErrorActionPreference='Stop'
Write-Output ('UID='+(& id -u))
& /usr/bin/python3 -I -m py_compile ops/ubuntu/deployment/stage08-authorize-prepare.py tool/stage08-policy-fixture-test.py
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
Write-Output 'STAGE08_PYTHON_SYNTAX_PASS'
& /usr/bin/python3 -I tool/stage08-policy-fixture-test.py
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
Write-Output 'STAGE08_LOCAL_FIXTURE_PASS'
