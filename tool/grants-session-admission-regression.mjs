import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = name => readFileSync(new URL("../src/"+name,import.meta.url),"utf8");
const guard = read("service/visible-browser-tools.ts");
const bridge = read("tool/web-domain-bridge.ts");
const grants = read("service/grants-browser-session.ts");

assert.ok(guard.includes('if (input.browserSession === "grants")'), "grants admission guard required");
assert.ok(guard.includes('const before = await inspectGrantsTarget'), "pre-operation grants identity proof required");
assert.ok(guard.includes('const after = await inspectGrantsTarget'), "post-operation grants identity proof required");
assert.ok(guard.includes('automatic_retry_allowed: false'), "unsafe automatic grants retries forbidden");
assert.ok(grants.includes('isGrantsAllowedUrl'), "grants destination allowlist required");
assert.ok(bridge.includes('browserSession === "grants" ? "http://127.0.0.1:8797"'), "dedicated grants route required");
assert.ok(bridge.includes('Grants runtime is pinned to 127.0.0.1:8797.'), "grants loopback pin required");
assert.ok(bridge.includes("quotaRotationInFlight"), "existing web quota recovery must survive integrations");
assert.ok(bridge.includes("rotateWebQuotaSession"), "web quota recovery operation must remain");
assert.ok(bridge.includes('browserSession !== "grants" && shouldRotateWebQuota'), "grants must never trigger generic Web Quota rotation");
console.log("Grants isolation, worker routing and Web Quota preservation source contract: PASS");
