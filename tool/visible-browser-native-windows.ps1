param([Parameter(Mandatory)][int]$Port)
$ErrorActionPreference = 'Stop'
# Read-only native evidence. No browser launch, cookie access, or cross-host routing.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class VisibleBrowserNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr window, IntPtr arg);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr arg);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
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
      if(pid==owner && IsWindowVisible(h) && !IsIconic(h) && desktop.IsWindowOnCurrentVirtualDesktop(h,out current)==0 && current && GetWindowRect(h,out r)) result.Add(new {id=h.ToInt64().ToString(),left=r.Left,top=r.Top,width=r.Right-r.Left,height=r.Bottom-r.Top}); return true; },IntPtr.Zero); }
    finally { Marshal.ReleaseComObject(desktop); }
    return result.ToArray();
  }
}
'@
$owners = @(Get-NetTCPConnection -LocalPort $Port -State Listen | Select-Object -ExpandProperty OwningProcess -Unique)
if ($owners.Count -ne 1) { throw 'Endpoint owner is ambiguous' }
$browserProcess = Get-Process -Id $owners[0]
$currentProcess = Get-Process -Id $PID
$cim = Get-CimInstance Win32_Process -Filter "ProcessId=$($browserProcess.Id)"
$owner = Invoke-CimMethod -InputObject $cim -MethodName GetOwner
$profile = [regex]::Match($cim.CommandLine, '--user-data-dir=(?:"([^"]+)"|([^\s]+))')
$profilePath = if ($profile.Groups[1].Success) { $profile.Groups[1].Value } else { $profile.Groups[2].Value }
[pscustomobject]@{
  pid = $browserProcess.Id
  name = $browserProcess.ProcessName
  sessionId = $browserProcess.SessionId
  sameSession = $browserProcess.SessionId -eq $currentProcess.SessionId -and $browserProcess.SessionId -gt 0
  sameUser = $owner.ReturnValue -eq 0 -and $owner.User -eq [Environment]::UserName -and $owner.Domain -eq [Environment]::UserDomainName
  user = "$($owner.Domain)\$($owner.User)"
  headless = $cim.CommandLine -match '--headless'
  profile = $profilePath
  startedAt = $browserProcess.StartTime.ToUniversalTime().ToString('o')
  inputReady = [VisibleBrowserNative]::InputReady() -and [VisibleBrowserNative]::SessionActive($browserProcess.SessionId)
  windows = @([VisibleBrowserNative]::Windows([uint32]$browserProcess.Id))
} | ConvertTo-Json -Depth 4 -Compress
