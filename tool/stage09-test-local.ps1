$ErrorActionPreference='Stop'
Write-Output ('UID='+(& id -u))
$helper='ops/ubuntu/deployment/stage09-authorize-validate.py'
$test='tool/stage09-policy-fixture-test.py'
& /usr/bin/python3 -I -c 'import ast, pathlib, sys; [ast.parse(pathlib.Path(p).read_text()) for p in sys.argv[1:]]; print("STAGE09_PYTHON_SYNTAX_PASS")' $helper $test
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
& /usr/bin/python3 -I $test
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
$out = & /usr/bin/python3 -I $helper --inspect 2>&1
if($LASTEXITCODE -eq 0 -or (($out | Out-String) -notmatch 'ADMIN_ROOT_SESSION_REQUIRED')){throw 'ROOT_BOUNDARY_NOT_ENFORCED'}
Write-Output 'STAGE09_SERVICE_UID_DENIED_PASS'
Write-Output ('STAGE09_HELPER_SHA256='+((& sha256sum $helper) -split ' ')[0])
Write-Output 'STAGE09_LOCAL_FIXTURE_PASS'
