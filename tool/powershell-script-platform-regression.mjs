import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "src/tool/powershell-script.ts"), "utf8");
assert.match(source, /process\.platform !== "win32"/);
assert.match(source, /detached: process\.platform !== "win32"/);
assert.match(source, /process\.kill\(-state\.pid, "SIGTERM"\)/);
assert.match(source, /process\.kill\(pid, 0\)/);
assert.match(source, /"taskkill"/);
assert.match(source, /"tasklist"/);
assert.match(source, /PowerShell executable must resolve to a native \.exe/);

const output = execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "'PW_SH_OK'"], { encoding: "utf8", timeout: 10000 });
assert.match(output, /PW_SH_OK/, "PowerShell Core must work on both CI platforms");

if (process.platform !== "win32") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  assert.ok(child.pid && child.pid > 0, "isolated process must start");
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  try {
    process.kill(child.pid, 0);
    process.kill(-child.pid, "SIGTERM");
    const exit = await Promise.race([
      new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
      new Promise((_, reject) => setTimeout(() => reject(new Error("process group did not exit")), 3000)),
    ]);
    assert.equal(exit.signal, "SIGTERM");
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}
console.log("powershell-script platform preflight: PASS");
