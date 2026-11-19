import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const helper = readFileSync("src/Infrastructure/Process/ManagedWindowsProcess.ts", "utf8");
assert.match(helper, /Number\.isSafeInteger\(pid\)/);
assert.match(helper, /Date\.parse\(spawnedAfter\)/);
assert.match(helper, /captureWindowsProcessIdentity/);
assert.match(helper, /PROCESS_CREATION_TICKS/);
assert.match(helper, /creationTicks/);
assert.match(helper, /\$p\.StartTime\.ToUniversalTime\(\)/);
assert.match(helper, /\.Ticks -ne \[long\]/);
assert.doesNotMatch(helper, /\$p\.Kill\(\$true\)/);
assert.match(helper, /PROCESS_IDENTITY_MISMATCH/);
assert.match(helper, /\$p\.Kill\(\)/);
assert.match(helper, /\$p\.WaitForExit\(10000\)/);
assert.doesNotMatch(helper, /taskkill/i);
for (const file of ["local-php-server", "mobile-edge-server", "visual-gallery-server"]) {
  const source = readFileSync("src/tool/" + file + ".ts", "utf8");
  assert.match(source, /stopBoundWindowsProcess\(/, file);
  assert.match(source, /captureWindowsProcessIdentity\(/, file);
  assert.match(source, /processCreationTicks: processCreationTicks/, file);
  assert.match(source, /state\.processCreationTicks/, file);
  assert.doesNotMatch(source, /"taskkill"/, file);
  assert.match(source, /managed_stop_not_verified/, file);
  assert.match(source, /stale_managed_state_requires_reconciliation/, file);
}
console.log("STAGE11_WINDOWS_PID_IDENTITY_STATIC_GUARD_PASS");
