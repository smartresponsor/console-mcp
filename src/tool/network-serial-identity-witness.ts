/**
 * Network M2 serial identity and control-line witness contract.
 *
 * This is a pure verifier: it cannot open TTY/COM, discover hardware, toggle
 * modem signals or authorize an OS handle. The future privileged backend is
 * responsible for obtaining real kernel/PnP observations before AND after
 * acquisition, and must reject any mismatch before consuming device bytes.
 */
import type { SerialPlanResult, SerialTarget } from "./network-serial-admission.js";

export type SerialIdentityWitness = Readonly<{
  platform: "linux" | "win32";
  device: string;
  instanceId: string;
  identity: string;
  dtr: false;
  rts: false;
  verified: true;
}>;

export type SerialWitnessResult =
  | { ok: false; status: string }
  | { ok: true; status: "SERIAL_IDENTITY_WITNESSED_OFFLINE";
      targetId: string; requiresKernelReverification: true; mayOpenDevice: false };

const LINUX_SYSFS_ID = /^\/sys\/devices\/[a-zA-Z0-9_./:-]{1,250}$/;
const WINDOWS_PNP_ID = /^[A-Z0-9_&\\-]{8,200}$/;
const LINUX_MM = /^(?:0|[1-9][0-9]{0,4}):(?:0|[1-9][0-9]{0,6})$/;
const WINDOWS_INSTANCE = /^(?:USB|FTDIBUS|ACPI)\\[A-Z0-9_&\\-]{4,180}$/;
const LINUX_DEVICE = /^\/dev\/tty(?:USB|ACM)(?:0|[1-9][0-9]{0,3})$/;
const WINDOWS_DEVICE = /^COM(?:[1-9]|[1-9][0-9]{1,3})$/;

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const existing = Object.keys(value);
  return existing.length === keys.length && existing.every((key) => keys.includes(key));
}

function witness(value: unknown): value is SerialIdentityWitness {
  if (!exactRecord(value, ["platform", "device", "instanceId", "identity", "dtr", "rts", "verified"])) return false;
  if (value.verified !== true || value.dtr !== false || value.rts !== false) return false;
  if (typeof value.instanceId !== "string" || typeof value.identity !== "string" ||
      typeof value.device !== "string") return false;
  if (value.platform === "linux") {
    return LINUX_DEVICE.test(value.device) && LINUX_SYSFS_ID.test(value.instanceId) &&
      !value.instanceId.split("/").includes("..") && LINUX_MM.test(value.identity);
  }
  return value.platform === "win32" && WINDOWS_DEVICE.test(value.device) &&
    WINDOWS_INSTANCE.test(value.instanceId) && WINDOWS_PNP_ID.test(value.identity);
}

/**
 * Accepts only an existing offline plan and an *admin-sourced* target/witnesses.
 * The untrusted caller MUST NOT be allowed to provide target or witness data.
 * A successful result is NOT a device-open authorization or OS attestation.
 */
export function compareSerialWitnesses(
  plan: SerialPlanResult,
  target: unknown,
  before: unknown,
  after: unknown,
): SerialWitnessResult {
  if (plan.ok !== true || plan.mayOpenDevice !== false ||
      plan.requiresOsDeviceVerification !== true || plan.status !== "SERIAL_PLAN_ONLY")
    return { ok: false, status: "SERIAL_PLAN_REQUIRED" };
  if (!exactRecord(target, ["id", "platform", "device", "profile", "baudRate", "dtr", "rts"]) ||
      target.id !== plan.targetId || target.platform !== plan.platform ||
      target.profile !== plan.profile || target.baudRate !== plan.baudRate ||
      target.dtr !== false || target.rts !== false)
    return { ok: false, status: "SERIAL_TARGET_BINDING_INVALID" };
  if (!witness(before) || !witness(after))
    return { ok: false, status: "SERIAL_IDENTITY_WITNESS_INVALID" };
  const required = target as SerialTarget;
  if (before.platform !== plan.platform || after.platform !== plan.platform ||
      before.device !== required.device || after.device !== required.device)
    return { ok: false, status: "SERIAL_DEVICE_CHANGED" };
  if (before.instanceId !== after.instanceId || before.identity !== after.identity)
    return { ok: false, status: "SERIAL_DEVICE_IDENTITY_CHANGED" };

  return { ok: true, status: "SERIAL_IDENTITY_WITNESSED_OFFLINE",
    targetId: plan.targetId, requiresKernelReverification: true, mayOpenDevice: false };
}
