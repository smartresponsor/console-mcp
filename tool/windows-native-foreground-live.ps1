param(
  [Parameter(Mandatory)][ValidatePattern('^[A-Fa-f0-9]{32}$')][string]$TargetId,
  [ValidateSet(9223,9224)][int]$Port = 9223,
  [switch]$WakeDisplay
)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Native Windows verification requires Windows.' }
if ($WakeDisplay) {
  # Explicit OS activation, never a side effect of the read-only verifier.
  $native = (& (Join-Path $PSScriptRoot 'visible-browser-native-windows.ps1') -Port $Port) | ConvertFrom-Json
  if (-not ($native.sameUser -and $native.sameSession -and $native.inputReady) -or $native.headless -or $native.name -notmatch '^(chrome|msedge|chromium)$') {
    throw 'Refusing display activation without native interactive browser ownership.'
  }
  Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public class ConsoleVerificationDisplayWake {
  [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);
}
'@
  # No ES_CONTINUOUS: reset the display idle timer once, without changing power policy.
  if ([ConsoleVerificationDisplayWake]::SetThreadExecutionState(2) -eq 0) { throw 'Windows refused display activation.' }
}
@'
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const { inspectVisibleTarget } = await import(pathToFileURL(resolve(process.argv[4], 'dist/service/visible-browser-session.js')).href);
const targetId=process.argv[2], port=Number(process.argv[3]);
const first=await inspectVisibleTarget({port,targetId,capability:'native-gui'});
const second=first.ok ? await inspectVisibleTarget({port,targetId,expected:first.evidence,capability:'native-gui'}) : null;
const background=second?.ok ? await inspectVisibleTarget({port,targetId,expected:second.evidence,background:true,capability:'native-gui'}) : null;
console.log(JSON.stringify({first,second,background,existingSessionsPreserved:true}));
assert.equal(first.ok,true,'Native foreground readiness is required');
assert.equal(second?.ok,true,'Sequential native identity must remain valid');
assert.equal(background?.ok,true);
assert.equal(background?.visibility_verified,false);
assert.equal(background?.user_interaction_ready,false);
'@ | node --input-type=module - $TargetId $Port (Split-Path $PSScriptRoot -Parent)
exit $LASTEXITCODE
