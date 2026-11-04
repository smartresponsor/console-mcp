# Read-only inspection of the exact disposable SCM probe fixture.
$ErrorActionPreference='Stop'
if(-not $IsWindows){throw 'SYSTEM_PROBE_WINDOWS_REQUIRED'}
$root='C:\Program Files\ConsoleMcpJournalProbeFixture'
$svc=Get-CimInstance Win32_Service -Filter "Name='ConsoleMcpJournalProbeFixture'" -ErrorAction Stop
$items=@()
foreach($path in @($root,(Join-Path $root 'probe-root'),(Join-Path $root 'probe-root/seal-authority'),(Join-Path $root 'probe-root/seal-authority/replay-journal'),(Join-Path $root 'ConsoleMcp.Sealer.SystemProbe.exe'),(Join-Path $root 'probe-pass.txt'))){
 $exists=[IO.File]::Exists($path) -or [IO.Directory]::Exists($path)
 $items+=@{path=$path;exists=$exists}
}
@{status='SYSTEM_PROBE_READONLY_INSPECT';service_exists=($null -ne $svc);
 service_state=if($svc){[string]$svc.State}else{''};paths=$items;
 production_changed=$false} | ConvertTo-Json -Compress -Depth 4
