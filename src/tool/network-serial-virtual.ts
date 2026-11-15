/**
 * Hardware-free Serial Console contract for Network M2.
 * No device path, process, shell, port handle, DTR/RTS or command write is exposed.
 * This module is intentionally NOT registered as an MCP tool.
 */
export type SerialCaptureRequest = {
  targetId: string;
  profile: "passive-9600-8n1" | "passive-115200-8n1";
  operation: "capture";
  authorization: "explicit-read-session";
};

export type SerialCaptureResult = {
  ok: boolean;
  status: string;
  targetId?: string;
  profile?: SerialCaptureRequest["profile"];
  output?: string;
  truncated?: boolean;
};

export type VirtualSerialTransport = {
  /** Captures frames produced by an offline fixture; never sends device commands. */
  frames: AsyncIterable<Uint8Array>;
  close: () => Promise<void>;
};

const MAX_CAPTURE_BYTES = 8192;
const MAX_FRAME_BYTES = 4096;
const MAX_CAPTURE_MS = 2000;
const TARGET_ID = /^[a-z][a-z0-9_-]{0,47}$/;
const PROFILES = new Set(["passive-9600-8n1", "passive-115200-8n1"]);

export function validateSerialCaptureRequest(value: unknown): SerialCaptureRequest | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== "authorization,operation,profile,targetId") return null;
  if (typeof input.targetId !== "string" || !TARGET_ID.test(input.targetId) ||
      typeof input.profile !== "string" || !PROFILES.has(input.profile) ||
      input.operation !== "capture" || input.authorization !== "explicit-read-session") return null;
  return input as SerialCaptureRequest;
}

function redact(text: string): string {
  return text.replace(/[^\r\n]*\b(?:password|token|secret|private[ _-]?key)\b\s*[:=][^\r\n]*/gi,
    "[REDACTED_SENSITIVE_LINE]");
}

/** Finite, fail-closed capture: timeout/cancel always attempt transport.close(). */
export async function captureVirtualSerial(
  request: unknown,
  transportFactory: (targetId: string) => Promise<VirtualSerialTransport>,
  signal?: AbortSignal,
  timeoutMs = MAX_CAPTURE_MS,
): Promise<SerialCaptureResult> {
  const parsed = validateSerialCaptureRequest(request);
  if (!parsed) return { ok: false, status: "SERIAL_REQUEST_INVALID" };
  if (signal?.aborted) return { ok: false, status: "SERIAL_CAPTURE_CANCELLED" };
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_CAPTURE_MS)
    return { ok: false, status: "SERIAL_TIMEOUT_INVALID" };

  let transport: VirtualSerialTransport | undefined;
  let settled = false;
  let closed = false;
  const close = async () => {
    if (!transport || closed) return;
    closed = true;
    try { await transport.close(); } catch { /* do not expose virtual fixture errors */ }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted = false;
  let onAbort: (() => void) | undefined;
  try {
    // Bound both factory creation and frame iteration.
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => { aborted = true; reject(new Error("cancelled")); };
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    });
    const work = (async (): Promise<SerialCaptureResult> => {
      transport = await transportFactory(parsed.targetId);
      if (settled) {
        await close();
        return { ok: false, status: "SERIAL_CAPTURE_CANCELLED_OR_TIMEOUT" };
      }
      if (!transport || !transport.frames || typeof transport.close !== "function")
        throw new Error("invalid transport");
      let bytes = 0;
      const parts: Uint8Array[] = [];
      for await (const frame of transport.frames) {
        if (!(frame instanceof Uint8Array) || frame.length > MAX_FRAME_BYTES)
          return { ok: false, status: "SERIAL_FRAME_INVALID" };
        if (bytes + frame.length > MAX_CAPTURE_BYTES)
          return { ok: true, status: "SERIAL_CAPTURE_TRUNCATED", targetId: parsed.targetId,
            profile: parsed.profile, output: redact(new TextDecoder().decode(Buffer.concat(parts))),
            truncated: true };
        bytes += frame.length;
        parts.push(frame);
      }
      return { ok: true, status: "SERIAL_CAPTURE_COMPLETE", targetId: parsed.targetId,
        profile: parsed.profile, output: redact(new TextDecoder().decode(Buffer.concat(parts))),
        truncated: false };
    })();
    // Ensure late factory completion still closes a handle after timeout.
    void work.catch(() => undefined);
    return await Promise.race([work, cancelled]);
  } catch {
    return { ok: false, status: aborted ? "SERIAL_CAPTURE_CANCELLED" : "SERIAL_CAPTURE_FAILED_OR_TIMEOUT" };
  } finally {
    settled = true;
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    await close();
  }
}
