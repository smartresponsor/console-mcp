param([ValidateSet('typecheck','build','test','transaction','probe')][string]$Step,[string]$CandidatePath,[string]$ControlRoot,[string]$NpmCommand)
$ErrorActionPreference='Stop'
Push-Location -LiteralPath $CandidatePath
try {
 if($Step -in @('typecheck','build','test')){
  if($Step -eq 'test'){& $NpmCommand test}else{& $NpmCommand run $Step}
 }elseif($Step -eq 'transaction'){
  & (Join-Path $PSScriptRoot 'runtime-release-v3-regression.ps1')
 }else{
  & (Join-Path $PSScriptRoot 'runtime-release-v3-candidate-probe.ps1') -CandidatePath $CandidatePath -ControlRoot $ControlRoot
 }
 exit $LASTEXITCODE
}finally{Pop-Location}
