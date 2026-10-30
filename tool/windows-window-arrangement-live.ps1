param([switch]$ApproveFixtureWindows)
$ErrorActionPreference='Stop'
if(-not $ApproveFixtureWindows -or -not $IsWindows -or [Diagnostics.Process]::GetCurrentProcess().SessionId -le 0){throw 'Explicit interactive fixture-window approval required'}
$native=Join-Path $PSScriptRoot 'visible-browser-native-windows.ps1'
$previous=(& $native -Operation window-inspect-focus | ConvertFrom-Json).activeWindowId
$production=Get-Process -Id (Get-NetTCPConnection -State Listen -LocalPort 3333|Select-Object -First 1 -ExpandProperty OwningProcess)
$productionStarted=$production.StartTime.ToUniversalTime().ToString('o')
. (Join-Path $PSScriptRoot 'test-fixture.ps1')
$fixture=New-ConsoleTestFixture -Prefix 'native-window-fixture'
$child=$null;$ids=@()
$receipt=Join-Path $fixture 'windows.json';$stop=Join-Path $fixture 'stop'
$childScript=Join-Path $fixture 'forms.ps1'
@'
param([string]$Receipt,[string]$Stop)
Add-Type -AssemblyName System.Windows.Forms
$first=[Windows.Forms.Form]::new();$second=[Windows.Forms.Form]::new()
foreach($form in @($first,$second)){$form.Text='Console disposable arrangement fixture';$form.StartPosition='Manual';$form.SetBounds(100,100,400,300);$form.Show()}
$timer=[Windows.Forms.Timer]::new();$timer.Interval=100
$timer.Add_Tick({if(Test-Path -LiteralPath $Stop){$timer.Stop();$first.Close();$second.Close();[Windows.Forms.Application]::ExitThread()}})
$timer.Start()
@(('0x'+$first.Handle.ToInt64().ToString('x')),('0x'+$second.Handle.ToInt64().ToString('x')))|ConvertTo-Json|Set-Content -LiteralPath $Receipt
try{[Windows.Forms.Application]::Run()}finally{$timer.Dispose();$first.Dispose();$second.Dispose()}
'@ | Set-Content -LiteralPath $childScript
try {
 $start=[Diagnostics.ProcessStartInfo]::new((Get-Command pwsh).Source)
 $start.UseShellExecute=$false;$start.CreateNoWindow=$true
 foreach($arg in @('-NoProfile','-STA','-File',$childScript,'-Receipt',$receipt,'-Stop',$stop)){$start.ArgumentList.Add($arg)}
 $child=[Diagnostics.Process]::Start($start)
 $deadline=[datetime]::UtcNow.AddSeconds(15)
 while(-not (Test-Path $receipt) -and -not $child.HasExited -and [datetime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 100}
 if(-not (Test-Path $receipt)){throw 'Fixture UI did not publish its exact handles'}
 $ids=@(Get-Content $receipt -Raw|ConvertFrom-Json)
 $dry=& (Join-Path $PSScriptRoot 'window-arrange-all.ps1') -WindowIds ($ids -join ',') | ConvertFrom-Json
 if(-not $dry.ok -or $dry.applied -or $dry.count -ne 2){throw 'Dry run changed or lost fixture selection'}
 $applied=& (Join-Path $PSScriptRoot 'window-arrange-all.ps1') -WindowIds ($ids -join ',') -Apply | ConvertFrom-Json
 if(-not $applied.ok -or $applied.windowsArranged -ne 2 -or $applied.positions.Count -ne 2){throw 'Fixture windows were not verifiably arranged'}
 $a=$applied.positions[0];$b=$applied.positions[1]
 if($a.x -lt $b.x+$b.width -and $a.x+$a.width -gt $b.x -and $a.y -lt $b.y+$b.height -and $a.y+$a.height -gt $b.y){throw 'Tiled fixture windows still overlap'}
 if((Get-Process -Id $production.Id).StartTime.ToUniversalTime().ToString('o') -cne $productionStarted){throw 'Production runtime changed during fixture test'}
 @{ok=$true;status='OWNED_WINDOW_ARRANGEMENT_LIVE_PASS';arranged=2;dryRunPassed=$true;productionChanged=$false}|ConvertTo-Json
}catch{
 $observed=(& $native -Operation window-inventory | ConvertFrom-Json)
 @{status='OWNED_WINDOW_FIXTURE_DIAGNOSTIC';selected=$ids;ownNativeWindows=$(if($child){@([VisibleBrowserNative]::Windows([uint32]$child.Id))}else{@()});ownInventory=@($observed.windows|Where-Object {$child -and $_.pid -eq $child.Id});productionChanged=$false}|ConvertTo-Json -Depth 6
 throw
}finally{
 $current='0x'+([long][VisibleBrowserNative]::ForegroundId()).ToString('x')
 $restore=$current -in $ids
 if($child){Set-Content -LiteralPath $stop -Value 'close';if(-not $child.WaitForExit(5000)){$child.Kill($true);$null=$child.WaitForExit(5000)};$child.Dispose()}
 if($restore -and $previous){$null=& $native -Operation window-activate -WindowId $previous -Approved}
 Remove-ConsoleTestFixture $fixture
}
