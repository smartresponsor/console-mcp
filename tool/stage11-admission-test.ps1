$ErrorActionPreference='Stop'
& /usr/bin/python3 -I -c 'import ast,pathlib; [ast.parse(pathlib.Path(p).read_text()) for p in ["ops/ubuntu/deployment/admission-lock.py","tool/stage11-admission-lock-fixture.py"]]; print("STAGE11_SYNTAX_PASS")'
if($LASTEXITCODE -ne 0){throw 'SYNTAX_FAILED'}
& /usr/bin/python3 -I tool/stage11-admission-lock-fixture.py
if($LASTEXITCODE -ne 0){throw 'MULTIPROCESS_FIXTURE_FAILED'}
Write-Output 'STAGE11_ADMISSION_PROTOTYPE_PASS'
