import assert from "node:assert/strict";
import { buildChatGptTitlePrefix, buildPrefixedChatTitle, buildShortChatStamp } from "../dist/service/chatgpt-component-label.js";

assert.equal(buildShortChatStamp("6a44512a-11f0-83ea-9368-9b009d1a76c4"), "6a44512a11");
assert.equal(buildShortChatStamp("abc123_chat-guard"), "abc123chat");
assert.equal(buildShortChatStamp("bad"), null);

assert.equal(buildChatGptTitlePrefix("cataloging", "6a44512a11"), "[cataloging:6a44512a11]");
assert.equal(buildPrefixedChatTitle("[cataloging:6a44512a11]", "Deep RC plan"), "[cataloging:6a44512a11] Deep RC plan");
assert.equal(buildPrefixedChatTitle("[cataloging:6a44512a11]", "[vendoring:abc123cha] Deep RC plan"), "[cataloging:6a44512a11] Deep RC plan");
assert.equal(buildPrefixedChatTitle("[cataloging:6a44512a11]", ""), "[cataloging:6a44512a11] New chat");

console.log(JSON.stringify({ ok: true, status: "CHATGPT_CHAT_LABEL_REGRESSION_OK" }, null, 2));
