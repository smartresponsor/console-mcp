import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { EbayStoreId } from "./ebay-store-routing.js";

export type EbayJobState = "QUEUED" | "AUTH_REQUIRED" | "IN_FLIGHT_UNCERTAIN" | "DRAFT_VERIFIED";
export type EbayJobRecord = Readonly<{ key: string; storeId: EbayStoreId; state: EbayJobState; updatedAt: string; draftId?: string }>;
const VALID_STORES = new Set(["parts", "toner", "general"]);
const VALID_STATES = new Set(["QUEUED", "AUTH_REQUIRED", "IN_FLIGHT_UNCERTAIN", "DRAFT_VERIFIED"]);

/** Durable per-job journal. Unknown interrupted writes are never automatically replayed. */
export class EbayStoreJobJournal {
  constructor(private readonly root: string) {}
  private path(key: string): string {
    if (!key || key.length > 256) throw new Error("INVALID_JOB_KEY");
    return join(this.root, createHash("sha256").update(key).digest("hex") + ".json");
  }
  async get(key: string): Promise<EbayJobRecord | null> {
    let raw: string;
    try { raw = await readFile(this.path(key), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") throw new Error("JOB_JOURNAL_CORRUPT");
    const item = value as Partial<EbayJobRecord>;
    if (item.key !== key || !VALID_STORES.has(item.storeId ?? "") || !VALID_STATES.has(item.state ?? "") || typeof item.updatedAt !== "string") throw new Error("JOB_JOURNAL_CORRUPT");
    return item as EbayJobRecord;
  }
  async enqueue(key: string, storeId: EbayStoreId): Promise<EbayJobRecord> {
    if (!VALID_STORES.has(storeId)) throw new Error("INVALID_STORE");
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const record: EbayJobRecord = { key, storeId, state: "QUEUED", updatedAt: new Date().toISOString() };
    let handle;
    try { handle = await open(path, "wx", 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("DUPLICATE_JOB"); throw error; }
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
    finally { await handle.close(); }
    return record;
  }
  /** Only an exclusive external worker lock may call transition; no implicit retry of uncertain writes. */
  async transition(key: string, expected: EbayJobState, next: EbayJobState, draftId?: string): Promise<EbayJobRecord> {
    const current = await this.get(key);
    if (!current || current.state !== expected) throw new Error("JOB_STATE_CONFLICT");
    const allowed: Record<EbayJobState, EbayJobState[]> = {
      QUEUED: ["AUTH_REQUIRED", "IN_FLIGHT_UNCERTAIN"],
      AUTH_REQUIRED: ["QUEUED"],
      IN_FLIGHT_UNCERTAIN: ["DRAFT_VERIFIED"],
      DRAFT_VERIFIED: [],
    };
    if (!allowed[expected].includes(next)) throw new Error("JOB_TRANSITION_FORBIDDEN");
    if (next === "DRAFT_VERIFIED" && !draftId) throw new Error("DRAFT_ID_REQUIRED");
    const record: EbayJobRecord = { ...current, state: next, updatedAt: new Date().toISOString(), ...(draftId ? { draftId } : {}) };
    const path = this.path(key);
    const temp = path + "." + randomUUID() + ".tmp";
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temp, path); } catch (error) { await unlink(temp).catch(() => {}); throw error; }
    return record;
  }
}
