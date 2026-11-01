import { inspectWindowsNative } from "./visible-browser-session.js";

// Desktop eligibility is not an exact target/window/foreground authorization.
export async function inspectWindowsPassiveStatus(port: number | undefined, timeoutMs: number,
  probe = inspectWindowsNative): Promise<Record<string, unknown>> {
  const base = { cdpReadiness: { ready: false, status: "EXACT_TARGET_NOT_VERIFIED", requiresDisplayOn: false, requiresForeground: false },
    nativeGuiReadiness: { ready: false, status: "DESKTOP_AND_TARGET_NOT_VERIFIED" }, ok: false, desktopEligible: false, visibilityVerified: false,
    userInteractionReady: false, requiresExactTargetVerification: true };
  if (port === undefined) return { ...base, status: "NOT_PROBED", reason: "NO_READY_CDP_ENDPOINT", endpoint: null, probeAttempted: false };
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return { ...base,
    status: "NOT_PROBED", reason: "INVALID_CDP_PORT", endpoint: null, probeAttempted: false };
  const endpoint = `http://127.0.0.1:${port}`;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) return { ...base, endpoint,
    status: "NOT_PROBED", reason: "DIAGNOSTIC_DEADLINE_EXHAUSTED", probeAttempted: false };
  const budget = Math.min(12000, Math.floor(timeoutMs));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const native = await Promise.race([
      probe(port, budget),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("NATIVE_PROBE_DEADLINE")), budget); }),
    ]);
    if (!native || !Number.isSafeInteger(native.pid) || native.pid <= 0 ||
        !Number.isInteger(native.sessionId) || typeof native.name !== "string" ||
        [native.sameUser, native.sameSession, native.inputReady, native.headless].some(v => typeof v !== "boolean")) {
      return { ...base, endpoint, probeAttempted: true, status: "WINDOWS_NATIVE_PROBE_UNAVAILABLE", reason: "INCOMPLETE_NATIVE_EVIDENCE" };
    }
    const reason = !/^(chrome|msedge|chromium)$/i.test(native.name) ? "NOT_BROWSER_PROCESS"
      : native.headless ? "HEADLESS_BROWSER" : native.sessionId <= 0 ? "NONINTERACTIVE_SESSION"
      : !native.sameUser ? "ACCOUNT_MISMATCH" : !native.sameSession ? "SESSION_MISMATCH"
      : !native.inputReady ? "INPUT_DESKTOP_UNAVAILABLE" : "DESKTOP_ELIGIBLE_TARGET_NOT_VERIFIED";
    const eligible = reason === "DESKTOP_ELIGIBLE_TARGET_NOT_VERIFIED";
    return { ...base, ok: eligible, desktopEligible: eligible, endpoint, probeAttempted: true,
      status: eligible ? "WINDOWS_NATIVE_DESKTOP_ELIGIBLE" : "WINDOWS_NATIVE_DESKTOP_INELIGIBLE", reason,
      cdpReadiness: { ready: false, status: "EXACT_TARGET_NOT_VERIFIED", requiresDisplayOn: false, requiresForeground: false,
        sessionEligible: /^(chrome|msedge|chromium)$/i.test(native.name) && !native.headless && native.sessionId > 0 && native.sameUser && native.sameSession && native.inputReady },
      nativeGuiReadiness: { ready: false, status: eligible ? "WINDOW_FOREGROUND_AND_TARGET_NOT_VERIFIED" : reason },
      sessionId: native.sessionId, browserPid: native.pid, sameUser: native.sameUser, sameSession: native.sameSession,
      inputReady: native.inputReady, headless: native.headless,
      sessionDisplayState: native.sessionDisplayState ?? null, consoleDisplayState: native.consoleDisplayState ?? null };
  } catch (error) {
    return { ...base, endpoint, probeAttempted: true, status: "WINDOWS_NATIVE_PROBE_UNAVAILABLE",
      reason: error instanceof Error && error.message === "NATIVE_PROBE_DEADLINE" ? "NATIVE_PROBE_TIMEOUT" : "NATIVE_PROBE_FAILED" };
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
