import assert from "node:assert/strict";
import { verifyDraft } from "../dist/Consumer/ChatGpt/Draft/ChatGptDraftVerifier.js";
import { createChatGptPromptDraft } from "../dist/Consumer/ChatGpt/Draft/ChatGptPromptDraft.js";

const expected = "Read only.\n\nInspect architecture and tests.\nPreserve every file.";
const proseMirror = "Read only.\n\n\nInspect architecture   and tests.\n\nPreserve every file.\n\n";
assert.equal(verifyDraft(expected, expected).draft_verification, "RAW_MATCH");
const equivalent = verifyDraft(expected, proseMirror);
assert.equal(equivalent.draft_verification, "NORMALIZED_MATCH");
assert.equal(equivalent.mismatch_classification, "whitespace_only");
assert.equal(equivalent.semantic_expected_hash, equivalent.semantic_actual_hash);
for (const actual of [expected.replace("tests", "writes"), expected.slice(0, -12), expected + expected, "Preserve every file. Read only. Inspect architecture and tests.", expected.replace("Read only", "Readonly"), expected.replace("tests.", "tests!")]) {
  const verification = verifyDraft(expected, actual);
  assert.equal(verification.draft_verification, "MISMATCH");
  assert.notEqual(verification.semantic_expected_hash, verification.semantic_actual_hash);
}
// Identical boundaries and raw length cannot authorize changed middle content.
const longExpected = "x ".repeat(80) + "preserve every file" + " y".repeat(80);
const changedMiddle = longExpected.replace("preserve", "overwrite");
function harness(before, after) {
  const calls = [];
  const target = { id: "fixture", port: 9223, web_socket_debugger_url: "ws://fixture" };
  let snapshots = 0;
  const draft = createChatGptPromptDraft({
    resolveTarget: async () => ({ ok: true, status: "READY", target }),
    readInputSnapshot: async () => ({ ok: true, text: snapshots++ === 0 ? before : after }),
    safeEvaluateInTarget: async () => ({ ok: true }),
    safeSendDevToolsCommand: async (_url, method) => { calls.push(method); return { ok: true }; },
    buildComposerFocusExpression: () => "true",
    compactChatGptTarget: () => ({ id: "fixture" }),
    redactInputSnapshot: snapshot => snapshot,
    normalizeTimeout: () => 1000,
  });
  return { draft, calls };
}
for (const [wanted, actual, passes] of [[expected, expected, true], [expected, proseMirror, true], [longExpected, changedMiddle, false], [expected, expected.slice(0, -12), false], [expected, expected + expected, false]]) {
  const postWrite = harness("", actual);
  const result = await postWrite.draft.draftInput({ prompt: wanted });
  assert.equal(result.ok, passes);
  assert.equal(result.submitted, false);
  assert.deepEqual(postWrite.calls, ["Input.insertText"]);
  const alreadyPresent = harness(actual, actual);
  const reused = await alreadyPresent.draft.draftInput({ prompt: wanted });
  assert.equal(reused.ok, passes);
  assert.equal(reused.submitted, false);
  assert.deepEqual(alreadyPresent.calls, []);
  const readOnly = harness(actual, actual);
  const verified = await readOnly.draft.verifyDraftInTarget({ expected: wanted });
  assert.equal(verified.ok, passes);
  assert.deepEqual(readOnly.calls, []);
}
console.log("Semantic draft verification regression: PASS (full content, existing draft, post-write DOM, no submission)");
