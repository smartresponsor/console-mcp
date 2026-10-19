// Ephemeral binding for the legacy ChatGPT schema (which omits browserSession).
// Never persists across process restarts; every operation still undergoes native visibility checks.
export type BoundWebTarget = { targetId: string; browserSession: 'visible' | 'isolated'; expiresAt: number };
let bound: BoundWebTarget | null = null;
export function currentBoundWebTarget(): BoundWebTarget | null {
  if (bound && Date.now() < bound.expiresAt) return bound;
  bound = null; return null;
}
export function rememberBoundWebTarget(targetId: string, browserSession: 'visible' | 'isolated'): void {
  bound = { targetId, browserSession, expiresAt: Date.now() + 10 * 60_000 };
}
export function clearBoundWebTarget(): void { bound = null; }
