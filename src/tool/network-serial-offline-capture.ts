/**
 * Offline-only serial capture coordinator. No OS device opening, modem ioctl,
 * login, write commands, PnP discovery or MCP registration.
 *
 * A trusted fixture factory is injected by tests, never by an MCP payload.
 * This is NOT a privileged OS backend: identity witness objects are fixture
 * claims until an independently validated kernel-handle backend exists.
 */
import { planSerialCapture, type SerialTarget } from "./network-serial-admission.js";
import { compareSerialWitnesses, type SerialIdentityWitness } from "./network-serial-identity-witness.js";
import { OfflineSerialLeaseCoordinator, type SerialLeaseResult } from "./network-serial-session-lease.js";

type FixtureSession = {
  before: SerialIdentityWitness;
  after: SerialIdentityWitness;
  frames: AsyncIterable<Uint8Array>;
  close: () => Promise<void>;
};
type FixtureFactory = (target: SerialTarget, signal: AbortSignal) => Promise<FixtureSession>;
type CaptureData = { status: "SERIAL_OFFLINE_CAPTURE_COMPLETE"; output: string; bytes: number };
export type OfflineCaptureResult = SerialLeaseResult<CaptureData> |
  {ok:false;status:"SERIAL_OFFLINE_ADMISSION_DENIED" | "SERIAL_OFFLINE_IDENTITY_DENIED"};

const MAX_FRAME = 1024;
const MAX_OUTPUT = 4096;
function redact(s: string): string {
  return s.replace(/\b(password|token|api[_-]?key|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

/** Do not export or register fixture-backed capture as an MCP command. */
export async function captureOfflineSerialFixture(
  request: unknown, targets: readonly SerialTarget[], approval: unknown, platform: string,
  leases: OfflineSerialLeaseCoordinator, factory: FixtureFactory,
  opts: Readonly<{ timeoutMs: number; signal?: AbortSignal }>,
): Promise<OfflineCaptureResult> {
  const plan = planSerialCapture(request, targets, approval, platform);
  if (!plan.ok) return {ok:false,status:"SERIAL_OFFLINE_ADMISSION_DENIED"};
  const target = targets.find(item => item.id === plan.targetId);
  if (!target) return {ok:false,status:"SERIAL_OFFLINE_ADMISSION_DENIED"};

  return leases.run(plan.targetId, async signal => {
    let session: FixtureSession | undefined;
    let taskFailed = false;
    let result: CaptureData | undefined;
    try {
      session = await factory(target, signal);
      if (signal.aborted) throw Error("cancelled");
      if (compareSerialWitnesses(plan, target, session.before, session.after).ok !== true)
        throw Error("identity check failed");
      let total = 0;
      const chunks: Uint8Array[] = [];
      for await (const frame of session.frames) {
        if (signal.aborted) throw Error("cancelled");
        if (!(frame instanceof Uint8Array) || frame.length > MAX_FRAME ||
            total + frame.length > MAX_OUTPUT) throw Error("frame policy");
        const copy = Uint8Array.from(frame);
        chunks.push(copy);
        total += copy.length;
      }
      if (signal.aborted) throw Error("cancelled");
      result = {status:"SERIAL_OFFLINE_CAPTURE_COMPLETE",
        output:redact(new TextDecoder("utf-8", {fatal:false}).decode(Buffer.concat(chunks))), bytes:total};
    } catch {
      taskFailed = true;
    } finally {
      if (session) {
        try { await session.close(); }
        catch { taskFailed = true; }
      }
    }
    if (taskFailed || !result || signal.aborted) throw Error("offline capture failed");
    return result;
  }, opts);
}
