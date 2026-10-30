param([switch]$Apply,[ValidatePattern('^0x[0-9a-fA-F]{1,16}(,0x[0-9a-fA-F]{1,16})*$')][string]$WindowIds)
$ErrorActionPreference='Stop'
if(-not $IsWindows -and [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT){throw 'WINDOW_PLATFORM_UNSUPPORTED'}
$inventory=& (Join-Path $PSScriptRoot 'visible-browser-native-windows.ps1') -Operation window-inventory | ConvertFrom-Json
if(-not $inventory.ok){$inventory|ConvertTo-Json -Depth 6;exit}
$windows=@($inventory.windows|Where-Object {$_.sameUser -and $_.sameSession -and $_.isVisible -and -not $_.isMinimized})
if($WindowIds){
 $selected=@($WindowIds.Split(',')|Sort-Object -Unique)
 $windows=@($windows|Where-Object {$_.windowId -in $selected})
 if($windows.Count -ne $selected.Count){throw 'WINDOW_ARRANGEMENT_TARGET_UNSAFE'}
}
if($windows.Count -gt 32){throw 'WINDOW_ARRANGEMENT_SELECTION_REQUIRED_MAX_32'}
if(-not $Apply){@{ok=$true;status='DRY_RUN';applied=$false;windows=$windows;count=$windows.Count}|ConvertTo-Json -Depth 6;exit}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ConsoleOwnedTile {
 [DllImport("user32.dll")] static extern ushort TileWindows(IntPtr parent,uint how,IntPtr rect,uint count,IntPtr windows);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 public static int Tile(long[] ids,uint[] owners){
  var buffer=Marshal.AllocHGlobal(IntPtr.Size*ids.Length);
  try {for(int i=0;i<ids.Length;i++){var h=new IntPtr(ids[i]);uint pid;if(GetWindowThreadProcessId(h,out pid)==0 || pid!=owners[i] || !IsWindowVisible(h) || IsIconic(h))throw new InvalidOperationException("Window identity changed");Marshal.WriteIntPtr(buffer,i*IntPtr.Size,h);}
   return ids.Length==0?0:TileWindows(IntPtr.Zero,1,IntPtr.Zero,(uint)ids.Length,buffer);
  }finally{Marshal.FreeHGlobal(buffer);}
 }
}
'@
foreach($window in $windows){
 $p=Get-Process -Id $window.pid
 $owner=Invoke-CimMethod -InputObject (Get-CimInstance Win32_Process -Filter "ProcessId=$($window.pid)") -MethodName GetOwnerSid
 if($p.StartTime.ToUniversalTime().Ticks -ne ([datetimeoffset]$window.processStartedAt).UtcDateTime.Ticks -or $p.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId -or $owner.ReturnValue -ne 0 -or $owner.Sid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value){throw 'WINDOW_ARRANGEMENT_IDENTITY_CHANGED'}
}
$count=[ConsoleOwnedTile]::Tile([long[]]@($windows|ForEach-Object {[Convert]::ToInt64($_.windowId.Substring(2),16)}),[uint32[]]@($windows|ForEach-Object {$_.pid}))
$observed=@([VisibleBrowserNative]::Windows(0));$verified=$true;$positions=@()
foreach($before in $windows){
 $after=@($observed|Where-Object {$_.id -eq [string][Convert]::ToInt64($before.windowId.Substring(2),16) -and $_.pid -eq $before.pid -and $_.visible -and -not $_.minimized -and $_.cloaked -eq 0})
 if($after.Count -ne 1 -or (Get-Process -Id $before.pid).StartTime.ToUniversalTime().Ticks -ne ([datetimeoffset]$before.processStartedAt).UtcDateTime.Ticks){$verified=$false}
 else{$positions+=@{windowId=$before.windowId;pid=$before.pid;x=$after[0].left;y=$after[0].top;width=$after[0].width;height=$after[0].height}}
}
$ok=$count -eq $windows.Count -and $verified
@{ok=$ok;status=$(if($ok){'WINDOWS_TILED'}else{'WINDOW_ARRANGEMENT_PARTIAL'});applied=$true;windowsArranged=$count;requested=$windows.Count;positions=$positions;visibility_verified=$false;user_interaction_ready=$false}|ConvertTo-Json -Depth 5
