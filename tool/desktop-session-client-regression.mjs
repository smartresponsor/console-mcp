import assert from "node:assert/strict";
import { inspectDesktopSessionAgent } from "../dist/service/desktop-session-client.js";

assert.equal((await inspectDesktopSessionAgent(0)).status, "DESKTOP_AGENT_INVALID_UID");
assert.equal((await inspectDesktopSessionAgent(1000, 0)).status, "DESKTOP_AGENT_INVALID_TIMEOUT");
assert.equal((await inspectDesktopSessionAgent(1000, 500)).userInteractionReady, false);

// Transport failure must never assert desktop readiness or a visible window.
const unavailable = await inspectDesktopSessionAgent(2147483647, 200);
assert.equal(unavailable.ok, false);
assert.equal(unavailable.visibilityVerified, false);
assert.equal(unavailable.userInteractionReady, false);
console.log("DESKTOP_SESSION_CLIENT_REGRESSION_GREEN");
