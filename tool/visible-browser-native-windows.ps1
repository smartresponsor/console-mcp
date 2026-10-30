param(
  [int]$Port,
  [ValidateSet('browser','window-inventory','window-inspect','window-inspect-focus','window-activate')][string]$Operation = 'browser',
  [ValidatePattern('^0x[0-9a-fA-F]{1,16}$')][string]$WindowId,
  [switch]$Approved
)
$ErrorActionPreference = 'Stop'
# Read-only native evidence. No browser launch, cookie access, or cross-host routing.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
public class VisibleBrowserNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr window, IntPtr arg);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr arg);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, System.Text.StringBuilder name, int count);
  [StructLayout(LayoutKind.Sequential)] struct GUIINFO { public int size,flags; public IntPtr active,focus,capture,menu,move,caret; public RECT rect; }
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GUIINFO info);
  public static string FocusId() { var info=new GUIINFO(); info.size=Marshal.SizeOf(info); return GetGUIThreadInfo(0,ref info) ? info.focus.ToInt64().ToString() : null; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);
  public static string ForegroundId() { return GetForegroundWindow().ToInt64().ToString(); }
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  public static bool Activate(long id, uint owner, uint expectedThread) {
    var h=new IntPtr(id); uint pid; int cloaked;
    if (!IsWindow(h) || GetWindowThreadProcessId(h,out pid)!=expectedThread || pid!=owner || !IsWindowVisible(h) || IsIconic(h) || DwmGetWindowAttribute(h,14,out cloaked,4)!=0 || cloaked!=0) return false;
    return SetForegroundWindow(h);
  }
  [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate uint PowerCallback(IntPtr context,uint type,IntPtr setting);
  [StructLayout(LayoutKind.Sequential)] struct PowerSubscription { public IntPtr Callback,Context; }
  [DllImport("powrprof.dll")] static extern uint PowerSettingRegisterNotification(ref Guid guid,uint flags,IntPtr recipient,out IntPtr handle);
  [DllImport("powrprof.dll")] static extern uint PowerSettingUnregisterNotification(IntPtr handle);
  public static int? DisplayState(string id) {
    try {
      Guid guid=new Guid(id); int state=-1;
      using(var received=new AutoResetEvent(false)) {
        PowerCallback callback=(context,type,setting)=>{ if(setting!=IntPtr.Zero && Marshal.ReadInt32(setting,16)==4){state=Marshal.ReadInt32(setting,20);received.Set();}return 0;};
        var subscription=new PowerSubscription{Callback=Marshal.GetFunctionPointerForDelegate(callback),Context=IntPtr.Zero};
        IntPtr recipient=Marshal.AllocHGlobal(Marshal.SizeOf(subscription)); IntPtr handle=IntPtr.Zero;
        try {
          Marshal.StructureToPtr(subscription,recipient,false);
          if(PowerSettingRegisterNotification(ref guid,2,recipient,out handle)!=0) return null;
          received.WaitOne(1000); return state>=0 && state<=2 ? (int?)state : null;
        } finally { if(handle!=IntPtr.Zero)PowerSettingUnregisterNotification(handle); Marshal.FreeHGlobal(recipient); GC.KeepAlive(callback); }
      }
    } catch { return null; }
  }

  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT rect);
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint id);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h, int index, System.Text.StringBuilder text, int length, out int needed);
  [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
  [DllImport("wtsapi32.dll")] static extern bool WTSQuerySessionInformation(IntPtr server, int session, int info, out IntPtr buffer, out int bytes);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr buffer);
  public static bool SessionActive(int session) { IntPtr buffer; int bytes; if(!WTSQuerySessionInformation(IntPtr.Zero,session,8,out buffer,out bytes)) return false; try {return bytes>=4 && Marshal.ReadInt32(buffer)==0;} finally {WTSFreeMemory(buffer);} }
  static string Name(IntPtr h) { int size; var s=new System.Text.StringBuilder(256); return GetUserObjectInformation(h,2,s,512,out size) ? s.ToString() : ""; }
  [ComImport, Guid("A5CD92FF-29BE-454C-8D04-D82879FB3F1B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IDesktop {
    [PreserveSig] int IsWindowOnCurrentVirtualDesktop(IntPtr h, out bool current);
    [PreserveSig] int GetWindowDesktopId(IntPtr h, out Guid id);
    [PreserveSig] int MoveWindowToDesktop(IntPtr h, ref Guid id);
  }
  public static bool InputReady() { var h=OpenInputDesktop(0,false,1); if(h==IntPtr.Zero) return false; try { return Name(GetProcessWindowStation())=="WinSta0" && Name(h)=="Default" && Name(GetThreadDesktop(GetCurrentThreadId()))=="Default"; } finally {CloseDesktop(h);} }
  public static object[] Windows(uint owner) {
    var result=new List<object>();
    var desktop=(IDesktop)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("AA509086-5CA9-4C25-8F95-589D3C07B48A")));
    try { EnumWindows((h,a)=>{ uint pid; GetWindowThreadProcessId(h,out pid); bool current; RECT r;
      if((owner==0 || pid==owner) && desktop.IsWindowOnCurrentVirtualDesktop(h,out current)==0 && current && GetWindowRect(h,out r)) {
        var name=new System.Text.StringBuilder(256); GetClassName(h,name,256);
        if(owner==0 && !IsWindowVisible(h) && !IsIconic(h) && name.ToString()!="Chrome_WidgetWin_1") return true;
        int cloaked; int status=DwmGetWindowAttribute(h,14,out cloaked,4); uint livePid; uint thread=GetWindowThreadProcessId(h,out livePid);
        if(IsWindow(h) && livePid==pid && thread!=0) result.Add(new {id=h.ToInt64().ToString(),pid=pid,threadId=thread,windowClass=name.ToString(),visible=IsWindowVisible(h),left=r.Left,top=r.Top,width=r.Right-r.Left,height=r.Bottom-r.Top,minimized=IsIconic(h),cloaked=status==0 ? (int?)cloaked : null});
      } return true; },IntPtr.Zero); }
    finally { Marshal.ReleaseComObject(desktop); }
    return result.ToArray();
  }
}
'@
function Get-WindowOwnerEvidence($window) {
  try {
    $process = Get-Process -Id $window.pid -ErrorAction Stop
    $created = $process.StartTime.ToUniversalTime().ToString('o')
    $instance = Get-CimInstance Win32_Process -Filter "ProcessId=$($window.pid)"
    $sid = Invoke-CimMethod -InputObject $instance -MethodName GetOwnerSid
    if ($sid.ReturnValue -ne 0) { return $null }
    # Re-enumerate after querying the process: destroyed/reassigned HWNDs are unsafe.
    $live = @([VisibleBrowserNative]::Windows([uint32]$window.pid) | Where-Object { $_.id -eq $window.id -and $_.threadId -eq $window.threadId })
    if ($live.Count -ne 1 -or $process.HasExited -or (Get-Process -Id $window.pid).StartTime.ToUniversalTime().ToString('o') -ne $created) { return $null }
    return [pscustomobject]@{
      windowId = '0x' + ([long]$window.id).ToString('x'); pid = $process.Id
      processStartedAt = $created; userSid = $sid.Sid; sessionId = $process.SessionId
      sameUser = $sid.Sid -eq [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
      sameSession = $process.SessionId -eq (Get-Process -Id $PID).SessionId -and $process.SessionId -gt 0
      title = $null; wmClass = $window.windowClass; desktop = 'WinSta0/Default'
      isActive = $window.id -eq [VisibleBrowserNative]::ForegroundId(); isFocused = $window.id -eq [VisibleBrowserNative]::FocusId()
      isVisible = $live[0].visible -and -not $live[0].minimized -and $live[0].cloaked -eq 0
      isMinimized = $live[0].minimized
      geometry = @{ x=$live[0].left; y=$live[0].top; width=$live[0].width; height=$live[0].height }
    }
  } catch { return $null }
}
if ($Operation -ne 'browser') {
  if ($Operation -eq 'window-activate' -and (-not $Approved -or -not $WindowId)) { throw 'Exact window and explicit activation approval required' }
  $ready = [VisibleBrowserNative]::InputReady() -and [VisibleBrowserNative]::SessionActive((Get-Process -Id $PID).SessionId)
  if (-not $ready) { @{ok=$false;status='WINDOW_DESKTOP_UNAVAILABLE';visibility_verified=$false} | ConvertTo-Json -Compress; exit }
  if ($Operation -eq 'window-inspect-focus') {
    $active = [VisibleBrowserNative]::ForegroundId(); $focus = [VisibleBrowserNative]::FocusId()
    @{ok=$true;status='WINDOW_FOCUS_INSPECTED';activeWindowId=('0x'+([long]$active).ToString('x'));inputFocusWindowId=$(if($focus){'0x'+([long]$focus).ToString('x')}else{$null});visibility_verified=$false} | ConvertTo-Json -Compress; exit
  }
  $windows = @([VisibleBrowserNative]::Windows(0) | Select-Object -First 128)
  if ($Operation -in @('window-inspect','window-activate')) { $windows = @($windows | Where-Object { ('0x'+([long]$_.id).ToString('x')) -eq $WindowId }) }
  $details = @($windows | ForEach-Object { Get-WindowOwnerEvidence $_ } | Where-Object { $_ -and $_.sameUser -and $_.sameSession })
  if ($Operation -eq 'window-activate') {
    if ($details.Count -ne 1 -or -not $details[0].isVisible) { @{ok=$false;status='WINDOW_ACTIVATION_TARGET_UNSAFE';visibility_verified=$false} | ConvertTo-Json -Compress; exit }
    $before=$details[0];$previous='0x'+([long][VisibleBrowserNative]::ForegroundId()).ToString('x')
    $accepted=[VisibleBrowserNative]::Activate([long]$windows[0].id,[uint32]$before.pid,[uint32]$windows[0].threadId)
    Start-Sleep -Milliseconds 100
    $after=Get-WindowOwnerEvidence $windows[0]
    $valid=$accepted -and $after -and $after.isActive -and $after.isVisible -and $after.sameUser -and $after.sameSession -and $after.pid -eq $before.pid -and $after.processStartedAt -ceq $before.processStartedAt
    @{ok=[bool]$valid;status=$(if($valid){'WINDOW_ACTIVATED'}else{'WINDOW_ACTIVATION_REFUSED'});window=$after;previousWindowId=$previous;visibility_verified=$false;user_interaction_ready=$false} | ConvertTo-Json -Depth 6 -Compress
    exit
  }
  if ($Operation -eq 'window-inspect') {
    if ($details.Count -eq 1) { @{ok=$true;status='WINDOW_INSPECTED';window=$details[0];visibility_verified=$false} | ConvertTo-Json -Depth 6 -Compress }
    else { @{ok=$false;status='WINDOW_NOT_LISTED';visibility_verified=$false} | ConvertTo-Json -Compress }
  } else { @{ok=$true;status='WINDOW_INVENTORY_READY';windows=$details;count=$details.Count;visibility_verified=$false} | ConvertTo-Json -Depth 6 -Compress }
  exit
}
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Invalid browser port' }
$owners = @(Get-NetTCPConnection -LocalPort $Port -State Listen | Select-Object -ExpandProperty OwningProcess -Unique)
if ($owners.Count -ne 1) { throw 'Endpoint owner is ambiguous' }
$browserProcess = Get-Process -Id $owners[0]
$creationBefore = $browserProcess.StartTime.ToUniversalTime().ToString('o')
$currentProcess = Get-Process -Id $PID
$cim = Get-CimInstance Win32_Process -Filter "ProcessId=$($browserProcess.Id)"
$owner = Invoke-CimMethod -InputObject $cim -MethodName GetOwner
$ownerSid = Invoke-CimMethod -InputObject $cim -MethodName GetOwnerSid
$profile = [regex]::Match($cim.CommandLine, '--user-data-dir=(?:"([^"]+)"|([^\s]+))')
$profilePath = if ($profile.Groups[1].Success) { $profile.Groups[1].Value } else { $profile.Groups[2].Value }
$consoleDisplayState = [VisibleBrowserNative]::DisplayState('6FE69556-704A-47A0-8F24-C28D936FDA47')
$sessionDisplayState = [VisibleBrowserNative]::DisplayState('2B84C20E-AD23-4DDF-93DB-05FFBD7EFCA5')
$foregroundBefore = [VisibleBrowserNative]::ForegroundId()
$nativeWindows = @([VisibleBrowserNative]::Windows([uint32]$browserProcess.Id) | Where-Object { $_.windowClass -eq 'Chrome_WidgetWin_1' })
$ownersAfter = @(Get-NetTCPConnection -LocalPort $Port -State Listen | Select-Object -ExpandProperty OwningProcess -Unique)
if ($ownersAfter.Count -ne 1 -or $ownersAfter[0] -ne $browserProcess.Id -or (Get-Process -Id $browserProcess.Id).StartTime.ToUniversalTime().ToString('o') -ne $creationBefore) { throw 'Endpoint identity changed' }
$foregroundAfter = [VisibleBrowserNative]::ForegroundId()
[pscustomobject]@{
  consoleDisplayState = $consoleDisplayState
  sessionDisplayState = $sessionDisplayState
  foregroundWindowIdBefore = $foregroundBefore
  foregroundWindowIdAfter = $foregroundAfter
  pid = $browserProcess.Id
  name = $browserProcess.ProcessName
  sessionId = $browserProcess.SessionId
  sameSession = $browserProcess.SessionId -eq $currentProcess.SessionId -and $browserProcess.SessionId -gt 0
  sameUser = $ownerSid.ReturnValue -eq 0 -and $ownerSid.Sid -eq [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  userSid = if ($ownerSid.ReturnValue -eq 0) { $ownerSid.Sid } else { $null }
  user = "$($owner.Domain)\$($owner.User)"
  headless = $cim.CommandLine -match '--headless'
  profile = $profilePath
  startedAt = $browserProcess.StartTime.ToUniversalTime().ToString('o')
  inputReady = [VisibleBrowserNative]::InputReady() -and [VisibleBrowserNative]::SessionActive($browserProcess.SessionId)
  windows = $nativeWindows
} | ConvertTo-Json -Depth 4 -Compress
