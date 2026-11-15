import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
function run(command, args, expected) {
  const result = spawnSync(command, args, {
    cwd: root, shell: false, encoding: "utf8", timeout: 10000,
    maxBuffer: 32768, windowsHide: true,
  });
  assert.equal(result.status, 0,
    `${command} fixture failed: ${result.error?.message ?? ""} ${result.stdout ?? ""} ${result.stderr ?? ""}`);
  assert.match(result.stdout, expected);
}
if (process.platform === "linux") {
  run("python3", ["-B", path.join(root, "tool/network-linux-pty-offline-regression.py")],
    /NETWORK_LINUX_PTY_READ_ONLY_FIXTURE_PASS/);
}
run("pwsh", ["-NoProfile", "-NonInteractive", "-File",
  path.join(root, "tool/network-windows-com-offline-regression.ps1")],
  /NETWORK_WINDOWS_COM_OFFLINE_POLICY_PASS/);
console.log("NETWORK_PTY_COM_OFFLINE_ACCEPTANCE_PASS", process.platform);
