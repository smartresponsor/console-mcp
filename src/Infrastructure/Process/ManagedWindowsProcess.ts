import { runSupervisedCommand } from "./SupervisedCommand.js";

/**
 * Fail-closed Windows managed-process stop with a process-object start-time check.
 * The .NET process-object API does not by itself prove handle-stable tree termination;
 * Windows-specific adversarial PID-reuse acceptance remains mandatory.
 * startedAt is the pre-spawn timestamp; reject processes that predate the spawn.
 */
export async function stopBoundWindowsProcess(cwd: string, pid: number, startedAt: string): Promise<{ ok: boolean; reason: string }> {
  const epoch = Date.parse(startedAt);
  if (process.platform !== "win32" || !Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(epoch)) {
    return { ok: false, reason: "invalid_process_identity" };
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "$p=$null",
    "try {",
    "  $p=[System.Diagnostics.Process]::GetProcessById(" + pid + ")",
    "  $actual=$p.StartTime.ToUniversalTime()",
    "  $earliest=[DateTimeOffset]::FromUnixTimeMilliseconds(" + Math.trunc(epoch - 2000) + ").UtcDateTime",
    "  $latest=[DateTimeOffset]::FromUnixTimeMilliseconds(" + Math.trunc(epoch + 5000) + ").UtcDateTime",
    "  if($actual -lt $earliest -or $actual -gt $latest){ throw 'PROCESS_IDENTITY_MISMATCH' }",
    "  if($p.HasExited){ throw 'PROCESS_ALREADY_EXITED' }",
    "  $p.Kill($true)",
    "  if(-not $p.WaitForExit(10000)){ throw 'PROCESS_TERMINATION_UNVERIFIED' }",
    "  'BOUND_PROCESS_STOP_CONFIRMED'",
    "} finally { if($null -ne $p){ $p.Dispose() } }",
  ].join("\n");
  const result = await runSupervisedCommand(cwd, "powershell", ["-NoProfile", "-NonInteractive", "-Command", script], 30000, 1024 * 1024);
  const ok = result.ok && result.stdout.includes("BOUND_PROCESS_STOP_CONFIRMED");
  return { ok, reason: ok ? "bound_stop_completed" : "bound_stop_failed" };
}
