import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EbayStoreJobJournal } from "../dist/service/ebay-store-job-journal.js";
const root = await mkdtemp(join(tmpdir(), "ebay-journal-regression-"));
try {
  const journal = new EbayStoreJobJournal(root);
  const key = "direct:parts:W10276397";
  const initial = await journal.enqueue(key, "parts");
  assert.equal(initial.state, "QUEUED");
  await assert.rejects(journal.enqueue(key, "parts"), /DUPLICATE_JOB/);
  assert.equal((await new EbayStoreJobJournal(root).get(key)).state, "QUEUED");
  await journal.transition(key, "QUEUED", "AUTH_REQUIRED");
  assert.equal((await journal.get(key)).state, "AUTH_REQUIRED");
  await assert.rejects(journal.transition(key, "QUEUED", "IN_FLIGHT_UNCERTAIN"), /JOB_STATE_CONFLICT/);
  await journal.transition(key, "AUTH_REQUIRED", "QUEUED");
  await journal.transition(key, "QUEUED", "IN_FLIGHT_UNCERTAIN");
  assert.equal((await new EbayStoreJobJournal(root).get(key)).state, "IN_FLIGHT_UNCERTAIN");
  await assert.rejects(journal.transition(key, "IN_FLIGHT_UNCERTAIN", "QUEUED"), /JOB_TRANSITION_FORBIDDEN/);
  await assert.rejects(journal.transition(key, "IN_FLIGHT_UNCERTAIN", "DRAFT_VERIFIED"), /DRAFT_ID_REQUIRED/);
  await journal.transition(key, "IN_FLIGHT_UNCERTAIN", "DRAFT_VERIFIED", "5425035479013");
  assert.equal((await journal.get(key)).draftId, "5425035479013");
  await assert.rejects(journal.transition(key, "DRAFT_VERIFIED", "QUEUED"), /JOB_TRANSITION_FORBIDDEN/);
  console.log("EBAY_STORE_JOURNAL_REGRESSION_PASS");
} finally { await rm(root, { recursive: true, force: true }); }
