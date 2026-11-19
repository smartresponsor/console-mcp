$ErrorActionPreference='Stop'
& npm run build
if($LASTEXITCODE -ne 0){throw 'STAGE11_BUILD_FAILED'}
& node tool/stage11-admission-integration-regression.mjs
if($LASTEXITCODE -ne 0){throw 'STAGE11_NODE_ADMISSION_FAILED'}
& /usr/bin/python3 -I tool/stage11-admission-lock-fixture.py
if($LASTEXITCODE -ne 0){throw 'STAGE11_PY_ADMISSION_FAILED'}
& /usr/bin/python3 -I -c 'import ast,pathlib; t=ast.parse(pathlib.Path("ops/ubuntu/deployment/prepare.py").read_text()); assert any(isinstance(x,ast.With) and "exclusive" in ast.unparse(x) and "validate(args.sha, deploy, gates)" in ast.unparse(x) for x in ast.walk(t)); print("STAGE11_ROOT_EXCLUSIVE_BOUNDARY_AST_PASS")'
if($LASTEXITCODE -ne 0){throw 'STAGE11_EXCLUSIVE_BOUNDARY_FAILED'}
& npm run test:async-command-run
if($LASTEXITCODE -ne 0){throw 'STAGE11_ASYNC_COMMAND_REGRESSION_FAILED'}
Write-Output 'STAGE11_INTEGRATION_TARGETED_PASS'
