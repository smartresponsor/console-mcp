/**
 * Windows COM metadata preflight contract. Read-only, injection-only.
 * This does NOT open COM, assert DTR/RTS safety or authorize device opening.
 * OS observation must be supplied by a trusted fixed native collector, never MCP.
 */
import type { SerialPlanResult, SerialTarget } from "./network-serial-admission.js";

export type WindowsSerialPnPObservation = Readonly<{
  port: string; instanceId: string; present: true; status: "OK";
  interfaceId: string;
}>;
export type WindowsSerialPnPSnapshot = Readonly<{ source: "windows-pnp"; rows: readonly WindowsSerialPnPObservation[] }>;
export type WindowsSerialPreflightResult =
  | { ok: false; status: "SERIAL_WINDOWS_PREFLIGHT_DENIED" | "SERIAL_WINDOWS_PNP_UNAVAILABLE" |
      "SERIAL_WINDOWS_PNP_AMBIGUOUS" | "SERIAL_WINDOWS_PNP_UNSTABLE" }
  | { ok: true; status: "SERIAL_WINDOWS_METADATA_ONLY"; targetId: string;
      mayOpenDevice: false; requiresOpenedHandleIdentity: true; modemLinesUnverified: true };

const COM = /^COM(?:[1-9]|[1-9][0-9]{1,3})$/;
const PNP = /^(?:USB|FTDIBUS|ACPI)\\[A-Z0-9_&\\-]{4,180}$/;
const INTERFACE = /^[A-Z0-9_&\\#{}?+.-]{8,256}$/;
function isPlain(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype;
}
function safeRow(v: unknown): v is WindowsSerialPnPObservation {
  if (!isPlain(v)) return false;
  return Object.keys(v).length === 5 &&
    ["port","instanceId","present","status","interfaceId"].every(k => Object.hasOwn(v,k)) &&
    typeof v.port === "string" && COM.test(v.port) &&
    typeof v.instanceId === "string" && PNP.test(v.instanceId) &&
    typeof v.interfaceId === "string" && INTERFACE.test(v.interfaceId) &&
    v.present === true && v.status === "OK";
}
function select(snapshot: unknown, port: string): WindowsSerialPnPObservation | null {
  if (!isPlain(snapshot) || Object.keys(snapshot).length !== 2 ||
      snapshot.source !== "windows-pnp" || !Array.isArray(snapshot.rows) ||
      snapshot.rows.length > 64 || !snapshot.rows.every(safeRow)) return null;
  const rows = snapshot.rows as WindowsSerialPnPObservation[];
  // Fail closed for duplicate port/instance/interface mappings, not just requested port.
  if (new Set(rows.map(r=>r.port)).size !== rows.length ||
      new Set(rows.map(r=>r.instanceId)).size !== rows.length ||
      new Set(rows.map(r=>r.interfaceId)).size !== rows.length) return null;
  return rows.find(row => row.port === port) ?? null;
}
export async function inspectWindowsSerialMetadataPreflight(
  plan: SerialPlanResult,
  target: SerialTarget,
  observe: () => Promise<unknown>,
): Promise<WindowsSerialPreflightResult> {
  const denied = {ok:false,status:"SERIAL_WINDOWS_PREFLIGHT_DENIED"} as const;
  if (plan.ok !== true || plan.status !== "SERIAL_PLAN_ONLY" ||
      plan.platform !== "win32" || plan.mayOpenDevice !== false ||
      plan.requiresOsDeviceVerification !== true || target.platform !== "win32" ||
      target.id !== plan.targetId || target.profile !== plan.profile ||
      target.baudRate !== plan.baudRate || target.dtr !== false || target.rts !== false ||
      !COM.test(target.device) || typeof observe !== "function") return denied;
  let first: unknown, second: unknown;
  try {
    first = await observe();
    second = await observe();
  } catch {
    return {ok:false,status:"SERIAL_WINDOWS_PNP_UNAVAILABLE"};
  }
  const before=select(first,target.device), after=select(second,target.device);
  if (!before || !after) return {ok:false,status:"SERIAL_WINDOWS_PNP_AMBIGUOUS"};
  if (before.instanceId !== after.instanceId || before.interfaceId !== after.interfaceId)
    return {ok:false,status:"SERIAL_WINDOWS_PNP_UNSTABLE"};
  return {ok:true,status:"SERIAL_WINDOWS_METADATA_ONLY",targetId:plan.targetId,
    mayOpenDevice:false,requiresOpenedHandleIdentity:true,modemLinesUnverified:true};
}
