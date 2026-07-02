import assert from "node:assert/strict";
import { buildChatGptTitlePrefix, buildPrefixedChatTitle, buildShortChatStamp } from "../dist/service/chatgpt-component-label.js";

assert.equal(buildShortChatStamp("6a44512a-11f0-83ea-9368-9b009d1a76c4"), "6a44512a1");
assert.equal(buildShortChatStamp("abc123_chat-guard"), "abc123_cha");
assert.equal(buildShortChatStamp("bad"), null);

assert.equal(buildChatGptTitlePrefix("cataloging", "6a44512a1"), "[cataloging:6a44512a1]");
assert.equal(buildPrefixedChatTitle("[cataloging:6a44512a1]", "Deep RC plan"), "[cataloging:6a44512a1] Deep RC plan");
assert.equal(buildPrefixedChatTitle("[cataloging:6a44512a1]", "[vendoring:abc123_cha] Deep RC plan"), "[cataloging:6a44512a1] Deep RC plan");
assert.equal(buildPrefixedChatTitle("[cataloging:6a44512a1]", ""), "[cataloging:6a44512a1] New chat");

console.log(JSON.stringify({ ok: true, status: "CHATGPT_CHAT_LABEL_REGRESSION_OK" }, null, 2));
