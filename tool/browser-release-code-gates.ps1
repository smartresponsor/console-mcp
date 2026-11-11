$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root
$checks=@('build','schema:validate','test:visible-session','smoke')
$results=@()
foreach($check in $checks){
  $output=@(& npm run $check 2>&1)
  $code=$LASTEXITCODE
  $results+= [pscustomobject]@{check=$check;passed=($code -eq 0);exitCode=$code}
  if($code -ne 0){
    $tail=@($output | Select-Object -Last 12) -join "`n"
    Write-Output ([pscustomobject]@{status='CANDIDATE_CODE_GATES_FAILED';checks=$results;diagnosticTail=$tail;liveAuthEvaluated=$false;deploymentAuthorized=$false}|ConvertTo-Json -Depth 5 -Compress)
    exit 1
  }
}
$transaction=@(& pwsh -NoProfile -File tool/browser-release-transaction-validation.ps1 2>&1)
$code=$LASTEXITCODE
$results+= [pscustomobject]@{check='transaction-and-deployment-fixtures';passed=($code -eq 0);exitCode=$code}
if($code -ne 0){
  Write-Output ([pscustomobject]@{status='CANDIDATE_CODE_GATES_FAILED';checks=$results;liveAuthEvaluated=$false;deploymentAuthorized=$false;diagnosticTail=(@($transaction|Select-Object -Last 10) -join "`n")}|ConvertTo-Json -Depth 5 -Compress)
  exit 1
}
Write-Output ([pscustomobject]@{status='CANDIDATE_CODE_GATES_GREEN_AUTH_NOT_TESTED';checks=$results;liveAuthEvaluated=$false;fullRcGreen=$false;deploymentAuthorized=$false}|ConvertTo-Json -Depth 5 -Compress)
