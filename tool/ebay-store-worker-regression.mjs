import assert from "node:assert/strict";
import { EbayStoreWriteCoordinator } from "../dist/service/ebay-store-worker.js";
const coordinator = new EbayStoreWriteCoordinator();
const now = Date.now();
const make = (id, port) => ({
  store: { id, category: id === "parts" ? "appliance-part" : "toner", state: "READY", profileId: `profile-${id}`, accountFingerprint: `account-${id}` },
  evidence: { storeId: id, profileId: `profile-${id}`, accountFingerprint: `account-${id}`, endpoint: `http://127.0.0.1:${port}/`, browserInstance: "/devtools/browser/123e4567-e89b-12d3-a456-426614174000", targetId: "0123456789ABCDEF0123456789ABCDEF", url: "https://www.ebay.com/sh/lst/drafts", verifiedAtEpochMs: now, accountIdentityVerified: true, browserProcessVerified: true }
});
const parts = make("parts", 9224);
const toner = make("toner", 9227);
let release;
const hold = new Promise(resolve => { release = resolve; });
let entered = false;
const first = coordinator.withVerifiedStore(parts.store, parts.evidence, async target => { entered = true; await hold; return target; });
assert.equal(entered, true);
await assert.rejects(coordinator.withVerifiedStore(parts.store, parts.evidence, async () => "bad"), /STORE_WRITE_BUSY/);
assert.equal(await coordinator.withVerifiedStore(toner.store, toner.evidence, async () => "independent"), "independent");
release();
assert.equal(await first, parts.evidence.targetId);
await assert.rejects(coordinator.withVerifiedStore(parts.store, parts.evidence, async () => { throw Error("OPERATION_FAILED"); }), /OPERATION_FAILED/);
assert.equal(await coordinator.withVerifiedStore(parts.store, parts.evidence, async () => "recovered"), "recovered");
await assert.rejects(coordinator.withVerifiedStore({ ...parts.store, state: "AUTH_REQUIRED" }, parts.evidence, async () => "bad"), /AUTH_REQUIRED/);
await assert.rejects(coordinator.withVerifiedStore(parts.store, { ...parts.evidence, storeId: "toner" }, async () => "bad"), /STORE_ID_MISMATCH/);
console.log("EBAY_STORE_WORKER_REGRESSION_PASS");
