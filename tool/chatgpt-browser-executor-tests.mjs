import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  classifyPostSubmitProbeState,
  classifySubmitOutcome,
  classifyTargetSelectionSnapshot,
  verifyDraft,
} from "../dist/service/browser-session-executor.js";

const rootTarget = (id, extra = {}) => ({
  id,
  type: "page",
  url: "https://chatgpt.com/",
  has_web_socket_debugger_url: true,
  composer_found: true,
  composer_text_length: 0,
  ...extra,
});

assert.equal(classifyTargetSelectionSnapshot([rootTarget("one")]).status, "TARGET_SELECTED");
assert.equal(classifyTargetSelectionSnapshot([rootTarget("one"), rootTarget("two")]).status, "TARGET_SELECTION_AMBIGUOUS");
assert.equal(classifyTargetSelectionSnapshot([
  { id: "login", type: "page", url: "https://chatgpt.com/auth/login", has_web_socket_debugger_url: true, composer_found: true, composer_text_length: 0 },
]).status, "TARGET_SELECTION_NOT_READY");

assert.equal(verifyDraft("hello", "hello").draft_verification, "RAW_MATCH");
assert.equal(verifyDraft("a\r\nb", "a\nb").draft_verification, "NORMALIZED_MATCH");
assert.equal(verifyDraft("hello\n", "hello").draft_verification, "NORMALIZED_MATCH");
assert.equal(verifyDraft("a b", "a\u00a0b").draft_verification, "NORMALIZED_MATCH");
assert.equal(verifyDraft("ab", "a\u200bb").draft_verification, "NORMALIZED_MATCH");
const deleted = verifyDraft("abcdef", "abc");
assert.equal(deleted.draft_verification, "MISMATCH");
assert.equal(deleted.mismatch_classification, "content_changed");

assert.deepEqual(
  pick(classifyPostSubmitProbeState({ root: true, busy: true, composer_text_length: 0, message_count: 0, user_message_count: 0, assistant_message_count: 0 }), ["status", "submitted", "empty_root_after_click"]),
  { status: "POST_SUBMIT_ROOT_EMPTY_NO_CHAT_ID", submitted: false, empty_root_after_click: true },
);
assert.equal(classifyPostSubmitProbeState({ root: true, composer_text_length: 0, message_count: 0 }).status, "POST_SUBMIT_ROOT_EMPTY_NO_CHAT_ID");
assert.equal(classifyPostSubmitProbeState({ root: false, chat_id: "abc123", message_count: 0 }).submitted, true);
assert.equal(classifyPostSubmitProbeState({ root: true, user_message_count: 1, message_count: 1 }).submitted, true);

const cli = spawnSync(process.execPath, ["dist/cli/chatgpt-browser-session-cli.js", "help"], { encoding: "utf8" });
assert.equal(cli.status, 0);
const cliJson = JSON.parse(cli.stdout);
assert.equal(cliJson.ok, true);
assert.ok(cliJson.commands.includes("chatgpt-send"));

const adapterShape = classifySubmitOutcome({ post_submit: { submitted: true, chat_id: "abc123" } });
assert.equal(adapterShape.ok, true);
assert.equal(adapterShape.status, "CHATGPT_SEND_DONE");

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

console.log(JSON.stringify({ ok: true, status: "CHATGPT_BROWSER_EXECUTOR_TESTS_PASSED" }, null, 2));
