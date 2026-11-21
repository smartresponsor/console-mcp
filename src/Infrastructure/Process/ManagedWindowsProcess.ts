import { runSupervisedCommand } from "./SupervisedCommand.js";

/** Capture the kernel process creation time in .NET ticks, not a wall-clock estimate. */
export async function captureWindowsProcessIdentity(cwd: string, pid: number, spawnedAfter: string): Promise<string | null> {
  const earliest = Date.parse(spawnedAfter);
  if (process.platform !== "win32" || !Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(earliest)) return null;
  const script = [
    "$ErrorActionPreference='Stop'",
    "$p=$null",
    "try {",
    "  $p=[System.Diagnostics.Process]::GetProcessById(" + pid + ")",
    "  if($p.HasExited){throw 'PROCESS_ALREADY_EXITED'}",
    "  $created=$p.StartTime.ToUniversalTime()",
    "  $earliest=[DateTimeOffset]::FromUnixTimeMilliseconds(" + Math.trunc(earliest - 2000) + ").UtcDateTime",
    "  if($created -lt $earliest){throw 'PROCESS_PREDATES_SPAWN'}",
    "  'PROCESS_CREATION_TICKS='+$created.Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture)",
    "} finally { if($null -ne $p){$p.Dispose()} }",
  ].join("\n");
  const result = await runSupervisedCommand(cwd, "pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], 30000, 1024 * 1024);
  const match = result.ok ? result.stdout.match(/PROCESS_CREATION_TICKS=(\d{15,19})/) : null;
  return match?.[1] ?? null;
}

/** Refuse to terminate any PID without an exact captured process creation identity. */
export async function stopBoundWindowsProcess(cwd: string, pid: number, creationTicks: string | undefined): Promise<{ ok: boolean; reason: string }> {
  if (process.platform !== "win32" || !Number.isSafeInteger(pid) || pid <= 0 || !creationTicks || !/^\d{15,19}$/.test(creationTicks)) {
    return { ok: false, reason: "invalid_process_identity" };
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "$p=$null",
    "try {",
    "  $p=[System.Diagnostics.Process]::GetProcessById(" + pid + ")",
    "  if($p.HasExited){throw 'PROCESS_ALREADY_EXITED'}",
    "  if($p.StartTime.ToUniversalTime().Ticks -ne [long]'" + creationTicks + "'){throw 'PROCESS_IDENTITY_MISMATCH'}",
    // No Kill(true): descendant enumeration is not handle-stable across PID reuse.
    "  $p.Kill()",
    "  if(-not $p.WaitForExit(10000)){throw 'PROCESS_TERMINATION_UNVERIFIED'}",
    "  'BOUND_PROCESS_STOP_CONFIRMED'",
    "} finally { if($null -ne $p){$p.Dispose()} }",
  ].join("\n");
  const result = await runSupervisedCommand(cwd, "pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], 30000, 1024 * 1024);
  const ok = result.ok && result.stdout.includes("BOUND_PROCESS_STOP_CONFIRMED");
  return { ok, reason: ok ? "bound_stop_completed" : "bound_stop_failed" };
}
