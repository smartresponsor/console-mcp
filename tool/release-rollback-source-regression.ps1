$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/89-release-v3-control.ps1')
$root=Join-Path ([IO.Path]::GetTempPath()) 'rollback-fixture'
$selected=@{sha=('a'*40);root=$root;entry=(Join-Path $root 'dist/index.js')}
$actual=Get-ReleaseV3SelectedRollbackSourceSha -Selected $selected -RollbackPath $root
if($actual -cne ('a'*40)){throw 'ROLLBACK_SHA_NOT_BORROWED_FROM_SELECTED'}
$bad=$selected.Clone();$bad.sha='previous-runtime-content-attested'
$blocked=$false
try{$null=Get-ReleaseV3SelectedRollbackSourceSha -Selected $bad -RollbackPath $root}catch{$blocked=$_.Exception.Message -eq 'RELEASE_ROLLBACK_SOURCE_SHA_UNATTESTED'}
if(-not $blocked){throw 'LEGACY_MARKER_ACCEPTED'}
$bad=$selected.Clone();$bad.sha=''
$blocked=$false
try{$null=Get-ReleaseV3SelectedRollbackSourceSha -Selected $bad -RollbackPath $root}catch{$blocked=$_.Exception.Message -eq 'RELEASE_ROLLBACK_SOURCE_SHA_UNATTESTED'}
if(-not $blocked){throw 'MISSING_SHA_ACCEPTED'}
$blocked=$false
try{$null=Get-ReleaseV3SelectedRollbackSourceSha -Selected $selected -RollbackPath ($root+'-other')}catch{$blocked=$_.Exception.Message -eq 'RELEASE_ROLLBACK_SELECTED_PATH_MISMATCH'}
if(-not $blocked){throw 'OTHER_RELEASE_PATH_ACCEPTED'}
$bad=$selected.Clone();$bad.entry=Join-Path $root 'other.js'
$blocked=$false
try{$null=Get-ReleaseV3SelectedRollbackSourceSha -Selected $bad -RollbackPath $root}catch{$blocked=$_.Exception.Message -eq 'RELEASE_ROLLBACK_SELECTED_ENTRY_MISMATCH'}
if(-not $blocked){throw 'OTHER_ENTRY_ACCEPTED'}
$control=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'dev-console.d/89-release-v3-control.ps1') -Raw
if($control.Contains("Get-ReleaseV3Descriptor `$Request.rollback_path 'previous-runtime-content-attested'") -or
  -not $control.Contains('Get-ReleaseV3SelectedRollbackSourceSha -Selected $active -RollbackPath $Request.rollback_path')){
  throw 'ROLLBACK_PREPARE_SOURCE_NOT_BOUND'
}
'RELEASE_ROLLBACK_SOURCE_REGRESSION_PASS'
