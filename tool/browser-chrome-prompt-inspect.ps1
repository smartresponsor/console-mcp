# Read-only UI Automation sensor for browser-owned Chrome/Edge modal surfaces.
# Never clicks, types, switches focus, kills a process or restarts the browser.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$BrowserPid)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class BrowserPromptWindows {
 [DllImport("user32.dll")] public static extern bool EnumWindows(Callback cb, IntPtr extra);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
 public delegate bool Callback(IntPtr hwnd, IntPtr extra);
 public static IntPtr[] ForPid(int pid) {
  var handles=new List<IntPtr>();
  EnumWindows((hwnd,extra)=>{uint owner;GetWindowThreadProcessId(hwnd,out owner);if(owner==(uint)pid)handles.Add(hwnd);return true;},IntPtr.Zero);
  return handles.ToArray();
 }
}
'@
$pattern='(?i)(restore (?:pages|tabs)|reopen closed|relaunch (?:to update|browser)|update (?:available|microsoft edge)|восстановить (?:страницы|вкладки)|перезапуст(?:ить|ите).{0,30}обнов|обновлени[ея].{0,30}(?:edge|браузер))'
$found=@()
$inspected=0
$errors=0
foreach($hwnd in [BrowserPromptWindows]::ForPid($BrowserPid)){
 if($inspected -ge 24){break}
 $inspected++
 try {
  $el=[System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if($null -eq $el){continue}
  $root=$el.Current
  if($root.ClassName -notmatch '^(Chrome_WidgetWin_1|#32770)$'){continue}
  $nodes=$el.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)
  $names=@([string]$root.Name)
  foreach($node in @($nodes | Select-Object -First 80)) {
   $current=$node.Current
   if($current.ControlType -in @([System.Windows.Automation.ControlType]::Text,[System.Windows.Automation.ControlType]::Button,[System.Windows.Automation.ControlType]::Window,[System.Windows.Automation.ControlType]::Pane)) {
    $names+=([string]$current.Name)
   }
  }
  foreach($text in $names){
   if(-not [string]::IsNullOrWhiteSpace($text) -and $text.Length -le 180 -and $text -match $pattern){
    $kind=if($text -match '(?i)(restore|reopen|восстановить)'){'RESTORE_PAGES'}else{'UPDATE_OR_RELAUNCH'}
    $found+=@{kind=$kind;window_id=('0x{0:x}' -f $hwnd.ToInt64());source='WINDOWS_UI_AUTOMATION';action='MANUAL_REVIEW';confirmed=$false}
    break
   }
  }
 }catch{$errors++}
}
@{ok=$true;status=if($found.Count){'BROWSER_CHROME_PROMPT_SUSPECTED'}else{'BROWSER_CHROME_PROMPT_UNOBSERVABLE'};browser_pid=$BrowserPid;inspected_window_count=$inspected;inspection_errors=$errors;observations=$found;mutation_attempted=$false;absence_verified=$false}|ConvertTo-Json -Depth 6 -Compress
