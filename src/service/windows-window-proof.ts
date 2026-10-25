export type WindowsNativeWindow = {
  id: string; left: number; top: number; width: number; height: number;
  minimized: boolean; cloaked: number | null;
  pid: number; threadId: number; windowClass: string; visible: boolean;
};
export type WindowsNativeSnapshot = {
  windows: WindowsNativeWindow[];
  foregroundWindowIdBefore: string;
  foregroundWindowIdAfter: string;
  consoleDisplayState: number | null; sessionDisplayState: number | null;
  pid: number;
};
export type WindowsWindowProof = {
  windowId: string | null;
  foregroundBefore: string | null; foregroundAfter: string | null;
  matchedCount: number;
  consoleDisplayState: number | null; sessionDisplayState: number | null;
  stage: string;
  reason: "VISIBILITY_UNKNOWN" | "SESSION_NOT_VISIBLE" | "AMBIGUOUS_VISIBLE_SESSIONS" | null;
  pageVisibility?: "visible" | "hidden" | "unavailable";
};

// Bounds identify a candidate; neither bounds nor page focus proves foreground ownership.
export function proveWindowsWindow(native: WindowsNativeSnapshot, bounds: {
  left: number; top: number; width: number; height: number; windowState: string;
}, background = false): WindowsWindowProof {
  const proof: WindowsWindowProof = {
    windowId: null, matchedCount: 0,
    consoleDisplayState: native.consoleDisplayState ?? null, sessionDisplayState: native.sessionDisplayState ?? null,
    foregroundBefore: native.foregroundWindowIdBefore ?? null,
    foregroundAfter: native.foregroundWindowIdAfter ?? null,
    stage: "window-unmatched", reason: "VISIBILITY_UNKNOWN",
  };
  const deny = (stage: string, reason: WindowsWindowProof["reason"] = "VISIBILITY_UNKNOWN") => ({ ...proof, stage, reason });
  if (bounds.windowState === "minimized") return deny("window-minimized", "SESSION_NOT_VISIBLE");
  if (![bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return deny("invalid-bounds");
  const matched = (Array.isArray(native.windows) ? native.windows : []).filter(w =>
    w.left === bounds.left && w.top === bounds.top && w.width === bounds.width && w.height === bounds.height);
  proof.matchedCount = matched.length;
  if (matched.length > 1) return deny("window-ambiguous", "AMBIGUOUS_VISIBLE_SESSIONS");
  if (matched.length !== 1 || !/^[1-9]\d*$/.test(matched[0].id)) return deny("window-unmatched");
  const window = matched[0]; proof.windowId = window.id;
  if (!Number.isSafeInteger(native.pid) || native.pid <= 0 || window.pid !== native.pid ||
      !Number.isSafeInteger(window.threadId) || window.threadId <= 0 || window.windowClass !== "Chrome_WidgetWin_1") return deny("window-owner-unavailable");
  if (window.visible === false) return deny("window-hidden", "SESSION_NOT_VISIBLE");
  if (window.visible !== true) return deny("window-state-unavailable");
  if (window.minimized === true || typeof window.cloaked === "number" && window.cloaked !== 0) return deny("window-hidden", "SESSION_NOT_VISIBLE");
  if (window.minimized !== false || window.cloaked !== 0) return deny("window-state-unavailable");
  if (!background) {
    if (proof.sessionDisplayState === 0) return deny("session-display-off", "SESSION_NOT_VISIBLE");
    if (proof.sessionDisplayState !== 1 && proof.sessionDisplayState !== 2) return deny("display-state-unavailable");
    if (!/^[1-9]\d*$/.test(proof.foregroundBefore ?? "") || !/^[1-9]\d*$/.test(proof.foregroundAfter ?? "")) return deny("foreground-unavailable");
    if (proof.foregroundBefore !== proof.foregroundAfter) return deny("foreground-changed");
    if (proof.foregroundAfter !== window.id) return deny("window-not-foreground", "SESSION_NOT_VISIBLE");
  }
  return { ...proof, stage: background ? "background-window-matched" : "foreground-window-matched", reason: null };
}
