import type { EbayStore, EbayStoreId } from "./ebay-store-routing.js";
import { verifyEbayStoreSession, type EbayBrowserEvidence } from "./ebay-store-session.js";

/** In-memory write lease; persistent queue required before production. */
export class EbayStoreWriteCoordinator {
  private readonly active = new Set<EbayStoreId>();
  async withVerifiedStore<T>(store: EbayStore, evidence: EbayBrowserEvidence | null, operation: (targetId: string) => Promise<T>): Promise<T> {
    const decision = verifyEbayStoreSession(store, evidence);
    if (!decision.ok) throw new Error(decision.reason);
    if (this.active.has(store.id)) throw new Error("STORE_WRITE_BUSY");
    this.active.add(store.id);
    try { return await operation(decision.targetId); }
    finally { this.active.delete(store.id); }
  }
}
