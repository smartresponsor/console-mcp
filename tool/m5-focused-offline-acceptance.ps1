param()
$ErrorActionPreference='Stop'
$steps=@(
 @{Label='M5_NATIVE';Cmd='node';Args=@('tool/m5-native-empty-capture-regression.mjs')},
 @{Label='M5_DOM';Cmd='node';Args=@('tool/m5-observed-turn-selector-regression.mjs')},
 @{Label='M5_EFFORT';Cmd='node';Args=@('tool/m5-static-effort-status-regression.mjs')},
 @{Label='M5_CONSOLE_REGRESSION';Cmd='pwsh';Args=@('-NoProfile','-File','tool/console-mcp-regression.ps1')}
)
foreach($step in $steps){
 Write-Output ('RUN='+$step.Label)
 & $step.Cmd @($step.Args)
 if($LASTEXITCODE -ne 0){throw ('FAILED='+$step.Label)}
 Write-Output ('PASS='+$step.Label)
}
