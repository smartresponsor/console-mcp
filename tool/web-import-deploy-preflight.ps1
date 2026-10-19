$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$script=Join-Path $root 'ops/ubuntu/script/deploy-web-artifact-import.sh'
& bash -n $script
if($LASTEXITCODE -ne 0){throw 'Deployment script syntax error'}
$stage=Join-Path $root 'tmp/visible-runtime-import-20261016'
Push-Location $stage
try{& sha256sum --check --quiet 'import-dist.sha256'; if($LASTEXITCODE -ne 0){throw 'Candidate hash verification failed'}}finally{Pop-Location}
Write-Output 'IMPORT_DEPLOY_PREFLIGHT_GREEN'
