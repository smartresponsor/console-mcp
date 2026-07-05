import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  classifyChatGptAuthState,
  classifyChatGptSendAuthOutcome,
  classifyPostSubmitProbeState,
  classifySessionWarmth,
  classifyWarmthRepairEligibility,
  classifySubmitOutcome,
  classifyTargetSelectionSnapshot,
  chooseWarmthRepairKeepTargetId,
  planRootTargetPrune,
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

const chatTarget = { id: "chat", type: "page", url: "https://chatgpt.com/c/abc123", chat_id: "abc123", port: 9223 };
const authTarget = { id: "auth", type: "page", url: "https://chatgpt.com/auth/login", chat_id: null, port: 9223 };
const settingsTarget = { id: "settings", type: "page", url: "https://chatgpt.com/settings", chat_id: null, port: 9223 };
const pruneTargets = [rootTarget("keep", { port: 9223, chat_id: null }), rootTarget("close", { port: 9223, chat_id: null }), chatTarget, authTarget, settingsTarget];
assert.equal(planRootTargetPrune(pruneTargets).status, "CHATGPT_ROOT_PRUNE_KEEP_TARGET_REQUIRED");
assert.equal(planRootTargetPrune(pruneTargets, "missing").status, "CHATGPT_ROOT_PRUNE_KEEP_TARGET_NOT_FOUND");
const prunePlan = planRootTargetPrune(pruneTargets, "keep", true);
assert.equal(prunePlan.status, "CHATGPT_ROOT_PRUNE_DONE");
assert.deepEqual(prunePlan.selected_for_close.map((target) => target.id), ["close"]);
assert.equal(prunePlan.selected_for_close.some((target) => ["chat", "auth", "settings"].includes(target.id)), false);
assert.deepEqual(planRootTargetPrune(pruneTargets, "chat", true).selected_for_close.map((target) => target.id), ["keep", "close"]);
assert.equal(planRootTargetPrune([rootTarget("root-a", { url: "https://chatgpt.com/c/abc123", chat_id: "abc123" }), rootTarget("root-b", { url: "https://chatgpt.com/auth/login" })], "root-a", true).selected_for_close.length, 0);

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

const guestAuth = classifyChatGptAuthState({ visibleText: "Log in Sign up for free Log in to get answers based on saved chats", url: "https://chatgpt.com/" });
assert.equal(guestAuth.authenticated, false);
assert.equal(guestAuth.guest_mode, true);
assert.equal(guestAuth.login_required, true);
assert.equal(classifyChatGptSendAuthOutcome({ authState: guestAuth, durable: true, allowGuestRootSession: true }).status, "CHATGPT_SEND_GUEST_DONE");
assert.deepEqual(
  pick(classifyChatGptSendAuthOutcome({ authState: guestAuth, durable: false, allowGuestRootSession: false }), ["status", "submitted"]),
  { status: "CHATGPT_SEND_AUTH_REQUIRED", submitted: false },
);
const authedAuth = classifyChatGptAuthState({ visibleText: "ChatGPT", url: "https://chatgpt.com/c/abc123", chatId: "abc123" });
assert.equal(classifyChatGptSendAuthOutcome({ authState: authedAuth, durable: true, chatId: "abc123" }).status, "CHATGPT_SEND_DONE");
const historyAuth = classifyChatGptAuthState({ visibleText: "Chat history Library Chats Project list", url: "https://chatgpt.com/" });
assert.equal(historyAuth.authenticated, true);
assert.equal(historyAuth.login_required, false);

const baseWarmInventory = (overrides = {}) => ({
  attempts: [{ ok: true, port: 9223 }],
  root_target_count: 1,
  chat_target_count: 0,
  auth_login_settings_target_count: 0,
  duplicate_chat_id_count: 0,
  selected_target_candidates: [rootTarget("warm")],
  ...overrides,
});
const warmSelected = { ok: true, status: "TARGET_SELECTED" };
const warmAuth = { authenticated: true, guest_mode: false, login_required: false, signals: [] };
assert.equal(classifySessionWarmth({ inventory: baseWarmInventory(), authState: guestAuth, selected: warmSelected, selectedTarget: rootTarget("guest") }).status, "CHATGPT_SESSION_WARMTH_AUTH_REQUIRED");
assert.equal(classifySessionWarmth({ inventory: baseWarmInventory(), authState: { authenticated: false, guest_mode: true, login_required: false, signals: [] }, selected: warmSelected, selectedTarget: rootTarget("guest") }).status, "CHATGPT_SESSION_WARMTH_GUEST_MODE");
assert.equal(classifySessionWarmth({ inventory: baseWarmInventory({ root_target_count: 2 }), authState: warmAuth, selected: warmSelected, selectedTarget: rootTarget("multi") }).status, "CHATGPT_SESSION_WARMTH_AMBIGUOUS_ROOT_TARGET");
assert.equal(classifySessionWarmth({ inventory: baseWarmInventory({ auth_login_settings_target_count: 1 }), authState: warmAuth, selected: warmSelected, selectedTarget: rootTarget("auth") }).status, "CHATGPT_SESSION_WARMTH_AUTH_TARGETS_PRESENT");
assert.equal(classifySessionWarmth({ inventory: baseWarmInventory(), authState: warmAuth, selected: warmSelected, selectedTarget: rootTarget("warm") }).status, "CHATGPT_SESSION_WARM");
const warmWarmth = classifySessionWarmth({ inventory: baseWarmInventory(), authState: warmAuth, selected: warmSelected, selectedTarget: rootTarget("warm") });
const ambiguousWarmth = classifySessionWarmth({ inventory: baseWarmInventory({ root_target_count: 2 }), authState: warmAuth, selected: warmSelected, selectedTarget: rootTarget("multi") });
assert.equal(classifyWarmthRepairEligibility(warmWarmth).status, "CHATGPT_SESSION_WARMTH_REPAIR_NOOP");
assert.equal(classifyWarmthRepairEligibility(ambiguousWarmth).status, "CHATGPT_SESSION_WARMTH_REPAIR_APPLICABLE");
assert.equal(classifyWarmthRepairEligibility({ ...ambiguousWarmth, authenticated: false, auth_state: { authenticated: false } }).status, "CHATGPT_SESSION_WARMTH_REPAIR_SKIPPED_AUTH_UNKNOWN");
assert.equal(classifyWarmthRepairEligibility({ ...ambiguousWarmth, guest_mode: true, auth_state: { ...warmAuth, guest_mode: true } }).status, "CHATGPT_SESSION_WARMTH_REPAIR_SKIPPED_GUEST_MODE");
assert.equal(classifyWarmthRepairEligibility({ ...ambiguousWarmth, login_required: true, auth_state: { ...warmAuth, login_required: true } }).status, "CHATGPT_SESSION_WARMTH_REPAIR_SKIPPED_LOGIN_REQUIRED");
assert.deepEqual(
  pick(chooseWarmthRepairKeepTargetId({ chat_targets: [chatTarget], empty_home_targets: [rootTarget("root-a", { port: 9223 })] }, ambiguousWarmth), ["keep_target_id", "keep_reason"]),
  { keep_target_id: "chat", keep_reason: "chat_target_present" },
);
assert.deepEqual(
  pick(chooseWarmthRepairKeepTargetId({ empty_home_targets: [rootTarget("b", { port: 9223 }), rootTarget("a", { port: 9223 })] }, { selected_target: rootTarget("b", { port: 9223 }) }), ["keep_target_id", "keep_reason"]),
  { keep_target_id: "b", keep_reason: "selected_root_target" },
);
assert.deepEqual(
  pick(chooseWarmthRepairKeepTargetId({ empty_home_targets: [rootTarget("b", { port: 9223 }), rootTarget("a", { port: 9223 })] }, ambiguousWarmth), ["keep_target_id", "keep_reason"]),
  { keep_target_id: "a", keep_reason: "stable_root_target" },
);

const rejected = spawnSync(process.execPath, ["dist/cli/chatgpt-browser-session-cli.js", "chatgpt-send-smoke", "--confirm-send"], { encoding: "utf8" });
assert.equal(rejected.status, 0);
const rejectedJson = JSON.parse(rejected.stdout);
if (rejectedJson.status === "TARGET_SELECTION_REJECTED_COMPOSER_NOT_EMPTY" || rejectedJson.status === "CHATGPT_SEND_TARGET_NOT_READY") {
  const rejections = rejectedJson.candidate_rejections ?? rejectedJson.target_selection?.candidate_rejections ?? [];
  if (rejections.length > 0) {
    const rejection = rejections[0];
    for (const key of [
      "target_id",
      "url",
      "title",
      "has_web_socket_debugger_url",
      "rejection_status",
      "rejection_reason",
      "composer_found",
      "composer_visible",
      "composer_text_length",
      "composer_text_sample_redacted_or_preview",
      "overlay_present",
      "send_control_found",
      "send_control_enabled",
      "message_count",
      "user_message_count",
      "assistant_message_count",
      "href",
      "readyState",
    ]) assert.ok(Object.hasOwn(rejection, key), `missing rejection key ${key}`);
    assert.ok(String(rejection.composer_text_sample_redacted_or_preview ?? "").length <= 120);
  }
}

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

console.log(JSON.stringify({ ok: true, status: "CHATGPT_BROWSER_EXECUTOR_TESTS_PASSED" }, null, 2));
