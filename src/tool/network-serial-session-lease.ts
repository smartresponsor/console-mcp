/**
 * Offline Network M2 Serial session lease coordinator.
 *
 * A lease is NOT an authorization to open a device. This module never creates
 * an OS handle or sends serial data. A privileged backend must separately
 * enforce admission, OS identity, DTR/RTS and handle-bound read-only policy.
 *
 * Crucial invariant: timeout/cancellation returns promptly but DOES NOT
 * release the lease until the underlying task actually settles. This prevents
 * a second session from opening while the first task may still own a handle.
 */
export type SerialLeaseResult<T> =
  | { ok: true; status: "SERIAL_LEASE_COMPLETED"; value: T }
  | { ok: false; status: "SERIAL_LEASE_REQUEST_INVALID" | "SERIAL_LEASE_BUSY" |
      "SERIAL_LEASE_CANCELLED" | "SERIAL_LEASE_TIMEOUT" | "SERIAL_LEASE_TASK_FAILED" };

const TARGET_ID = /^[a-z][a-z0-9_-]{0,47}$/;
const MAX_DURATION_MS = 5000;

export class OfflineSerialLeaseCoordinator {
  private readonly active = new Set<string>();

  isLeased(targetId: string): boolean {
    return this.active.has(targetId);
  }

  async run<T>(
    targetId: string,
    task: (signal: AbortSignal) => Promise<T>,
    options: Readonly<{ timeoutMs: number; signal?: AbortSignal }>,
  ): Promise<SerialLeaseResult<T>> {
    if (!TARGET_ID.test(targetId) || typeof task !== "function" ||
        !options || !Number.isInteger(options.timeoutMs) ||
        options.timeoutMs < 1 || options.timeoutMs > MAX_DURATION_MS)
      return { ok: false, status: "SERIAL_LEASE_REQUEST_INVALID" };

    if (this.active.has(targetId))
      return { ok: false, status: "SERIAL_LEASE_BUSY" };

    if (options.signal?.aborted)
      return { ok: false, status: "SERIAL_LEASE_CANCELLED" };

    this.active.add(targetId);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    try {
      const interrupted = new Promise<SerialLeaseResult<T>>((resolve) => {
        let finished = false;
        const stop = (status: "SERIAL_LEASE_TIMEOUT" | "SERIAL_LEASE_CANCELLED") => {
          if (finished) return;
          finished = true;
          controller.abort();
          resolve({ ok: false, status });
        };
        abortListener = () => stop("SERIAL_LEASE_CANCELLED");
        options.signal?.addEventListener("abort", abortListener, { once: true });
        timer = setTimeout(() => stop("SERIAL_LEASE_TIMEOUT"), options.timeoutMs);
      });

      // The task owns its cleanup. A stuck task retains this target's lease;
      // late errors are contained and cannot become unhandled rejections.
      const completion = Promise.resolve()
        .then(() => task(controller.signal))
        .then((value): SerialLeaseResult<T> => ({ ok: true, status: "SERIAL_LEASE_COMPLETED", value }),
          (): SerialLeaseResult<T> => ({ ok: false, status: "SERIAL_LEASE_TASK_FAILED" }))
        .finally(() => { this.active.delete(targetId); });

      return await Promise.race([completion, interrupted]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abortListener) options.signal?.removeEventListener("abort", abortListener);
    }
  }
}
