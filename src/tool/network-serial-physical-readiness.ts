/**
 * Network M2 physical Serial safety barrier.
 *
 * Deliberately NOT an OS serial backend. A metadata-only preflight, an
 * application-supplied witness, and an approval are not sufficient to call
 * Linux open(2) or Windows CreateFile. In particular, opening a USB-serial
 * driver can assert DTR/RTS before userspace sets line state.
 *
 * This module is pure and never opens a handle or grants opening authority.
 * Future enabling work MUST replace this barrier in a separately reviewed PR
 * with device-specific evidence, an OS-owned handle identity and cleanup proof.
 */
import type { SerialPlanResult, SerialTarget } from "./network-serial-admission.js";

export type SerialPhysicalBlocker =
  | "NO_DRIVER_SPECIFIC_NO_TOGGLE_PROOF"
  | "NO_KERNEL_BOUND_HANDLE_IDENTITY"
  | "NO_OS_ENFORCED_LINE_STATE"
  | "NO_PRIVILEGED_CLEANUP_ATTESTATION"
  | "NO_HARDWARE_ACCEPTANCE";

export type SerialPhysicalReadinessResult =
  | { ok:false; status:"SERIAL_PHYSICAL_PLAN_DENIED"; mayOpenDevice:false }
  | { ok:false; status:"SERIAL_PHYSICAL_OPEN_BLOCKED"; targetId:string;
      mayOpenDevice:false; blockers:readonly SerialPhysicalBlocker[] };

const blockers = Object.freeze([
  "NO_DRIVER_SPECIFIC_NO_TOGGLE_PROOF",
  "NO_KERNEL_BOUND_HANDLE_IDENTITY",
  "NO_OS_ENFORCED_LINE_STATE",
  "NO_PRIVILEGED_CLEANUP_ATTESTATION",
  "NO_HARDWARE_ACCEPTANCE",
] as const);

/**
 * The only valid input is a previously admitted metadata-only plan and
 * matching trusted target. No caller-supplied proof or force flag is accepted.
 * The return type intentionally has no ok:true branch.
 */
export function assessPhysicalSerialReadiness(
  plan: SerialPlanResult, target: SerialTarget,
): SerialPhysicalReadinessResult {
  if (plan.ok !== true || plan.status !== "SERIAL_PLAN_ONLY" ||
      plan.requiresOsDeviceVerification !== true || plan.mayOpenDevice !== false ||
      target.id !== plan.targetId || target.platform !== plan.platform ||
      target.profile !== plan.profile || target.baudRate !== plan.baudRate ||
      target.dtr !== false || target.rts !== false ||
      (target.platform !== "linux" && target.platform !== "win32"))
    return {ok:false,status:"SERIAL_PHYSICAL_PLAN_DENIED",mayOpenDevice:false};

  return {ok:false,status:"SERIAL_PHYSICAL_OPEN_BLOCKED",
    targetId:plan.targetId,mayOpenDevice:false,blockers};
}
