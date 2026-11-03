$ErrorActionPreference='Stop'
$root=Resolve-Path (Join-Path $PSScriptRoot '..')
Push-Location $root
try {
 & /usr/bin/python3 -I -c 'import ast; ast.parse(open("ops/ubuntu/deployment/release-broker.py",encoding="utf-8").read()); print("BROKER_AST_OK")'
 if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
 & /usr/bin/python3 -I ops/ubuntu/deployment/release-broker-regression.py
 if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
}finally{Pop-Location}
