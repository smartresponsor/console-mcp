param([switch]$ApproveFixtureWindows)
$ErrorActionPreference='Stop'
if(-not $ApproveFixtureWindows -or -not $IsWindows -or [Diagnostics.Process]::GetCurrentProcess().SessionId -le 0){throw 'Explicit interactive fixture-window approval required'}
$native=Join-Path $PSScriptRoot 'visible-browser-native-windows.ps1'
$previous=(& $native -Operation window-inspect-focus | ConvertFrom-Json).activeWindowId
$production=Get-Process -Id (Get-NetTCPConnection -State Listen -LocalPort 3333|Select-Object -First 1 -ExpandProperty OwningProcess)
$productionStarted=$production.StartTime.ToUniversalTime().ToString('o')
Add-Type -AssemblyName System.Windows.Forms
$one=[Windows.Forms.Form]::new();$two=[Windows.Forms.Form]::new();$ids=@()
try {
 foreach($form in @($one,$two)){
  $form.Text='Console owned arrangement fixture '+[guid]::NewGuid().ToString('N')
  $form.StartPosition='Manual';$form.SetBounds(100,100,400,300);$form.Show()
 }
 [Windows.Forms.Application]::DoEvents()
 $ids=@(('0x'+$one.Handle.ToInt64().ToString('x')),('0x'+$two.Handle.ToInt64().ToString('x')))
 $dry=& (Join-Path $PSScriptRoot 'window-arrange-all.ps1') -WindowIds ($ids -join ',') | ConvertFrom-Json
 if(-not $dry.ok -or $dry.applied -or $dry.count -ne 2){throw 'Dry run changed or lost fixture selection'}
 $applied=& (Join-Path $PSScriptRoot 'window-arrange-all.ps1') -WindowIds ($ids -join ',') -Apply | ConvertFrom-Json
 [Windows.Forms.Application]::DoEvents()
 if(-not $applied.ok -or $applied.windowsArranged -ne 2 -or $applied.positions.Count -ne 2){throw 'Fixture windows were not verifiably arranged'}
 $a=$applied.positions[0];$b=$applied.positions[1]
 if($a.x -lt $b.x+$b.width -and $a.x+$a.width -gt $b.x -and $a.y -lt $b.y+$b.height -and $a.y+$a.height -gt $b.y){throw 'Tiled fixture windows still overlap'}
 if((Get-Process -Id $production.Id).StartTime.ToUniversalTime().ToString('o') -cne $productionStarted){throw 'Production runtime changed during fixture test'}
 @{ok=$true;status='OWNED_WINDOW_ARRANGEMENT_LIVE_PASS';arranged=2;dryRunPassed=$true;productionChanged=$false}|ConvertTo-Json
}finally{
 $current='0x'+([long][VisibleBrowserNative]::ForegroundId()).ToString('x')
 $restore=$current -in $ids
 $one.Close();$two.Close();$one.Dispose();$two.Dispose()
 if($restore -and $previous){$null=& $native -Operation window-activate -WindowId $previous -Approved}
}
