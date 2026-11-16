/**
 * Network M2: offline admission planner for future physical serial capture.
 *
 * Pure policy check only. It never opens COM/TTY, calls SerialPort, resolves a
 * symlink, changes line state or writes bytes. An OS-specific backend MUST
 * re-verify ownership, canonical device and DTR/RTS before any future open.
 *
 * The target inventory and approval must be supplied by trusted local admin
 * policy and authorization layers; neither is accepted from the MCP request.
 */
export type SerialPlatform = "linux" | "win32";
export type SerialObservation = "capture";
export type SerialProfile = "status-only";

export type SerialTarget = Readonly<{
  id: string;
  platform: SerialPlatform;
  device: string;
  profile: SerialProfile;
  baudRate: 9600 | 115200;
  dtr: false;
  rts: false;
}>;

export type SerialApproval = Readonly<{
  targetId: string;
  observation: SerialObservation;
  approved: true;
}>;

export type SerialPlanResult =
  | { ok: false; status: string }
  | { ok: true; status: "SERIAL_PLAN_ONLY"; targetId: string;
      platform: SerialPlatform; profile: SerialProfile; baudRate: 9600 | 115200;
      requiresOsDeviceVerification: true; mayOpenDevice: false };

const TARGET_ID = /^[a-z][a-z0-9_-]{0,47}$/;
const LINUX_DEVICE = /^\/dev\/tty(?:USB|ACM)(?:0|[1-9][0-9]{0,3})$/;
const WINDOWS_DEVICE = /^COM(?:[1-9]|[1-9][0-9]{1,3})$/;

function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function validTarget(target: unknown): target is SerialTarget {
  if (!record(target, ["id", "platform", "device", "profile", "baudRate", "dtr", "rts"])) return false;
  if (typeof target.id !== "string" || !TARGET_ID.test(target.id)) return false;
  if (target.platform !== "linux" && target.platform !== "win32") return false;
  if (typeof target.device !== "string") return false;
  if (target.platform === "linux" ? !LINUX_DEVICE.test(target.device) : !WINDOWS_DEVICE.test(target.device)) return false;
  return target.profile === "status-only" &&
    (target.baudRate === 9600 || target.baudRate === 115200) &&
    target.dtr === false && target.rts === false;
}

/**
 * request: untrusted MCP payload: exact {targetId, observation}; no paths/commands.
 * targets: admin-provisioned immutable inventory, never selected by MCP client.
 * approval: separately verified local authorization decision, not client input.
 * hostPlatform: host OS classification, not read from request.
 */
export function planSerialCapture(
  request: unknown, targets: readonly unknown[], approval: unknown,
  hostPlatform: string,
): SerialPlanResult {
  if (!record(request, ["targetId", "observation"]) ||
      typeof request.targetId !== "string" || !TARGET_ID.test(request.targetId) ||
      request.observation !== "capture") return { ok: false, status: "SERIAL_REQUEST_INVALID" };

  if (hostPlatform !== "linux" && hostPlatform !== "win32")
    return { ok: false, status: "SERIAL_PLATFORM_UNSUPPORTED" };

  // Reject malformed or ambiguous inventory before considering authorization.
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 32 ||
      targets.some((target) => !validTarget(target))) {
    return { ok: false, status: "SERIAL_POLICY_INVALID" };
  }
  const ids = new Set(targets.map((target) => (target as SerialTarget).id));
  const devices = new Set(targets.map((target) => `${(target as SerialTarget).platform}:${(target as SerialTarget).device}`));
  if (ids.size !== targets.length || devices.size !== targets.length)
    return { ok: false, status: "SERIAL_POLICY_AMBIGUOUS" };

  const target = targets.find((entry) => (entry as SerialTarget).id === request.targetId) as SerialTarget | undefined;
  if (!target) return { ok: false, status: "SERIAL_TARGET_NOT_PROVISIONED" };
  if (target.platform !== hostPlatform) return { ok: false, status: "SERIAL_TARGET_PLATFORM_MISMATCH" };

  if (!record(approval, ["targetId", "observation", "approved"]) ||
      approval.approved !== true || approval.targetId !== target.id ||
      approval.observation !== request.observation) {
    return { ok: false, status: "SERIAL_AUTHORIZATION_REQUIRED" };
  }

  return {
    ok: true, status: "SERIAL_PLAN_ONLY", targetId: target.id,
    platform: target.platform, profile: target.profile, baudRate: target.baudRate,
    requiresOsDeviceVerification: true, mayOpenDevice: false,
  };
}
