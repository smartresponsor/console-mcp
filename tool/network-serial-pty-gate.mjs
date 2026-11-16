/** Offline Linux PTY acceptance. Windows uses the independent COM mock suite. */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (process.platform !== "linux") {
  console.log("NETWORK_SERIAL_PTY_SKIPPED_NON_LINUX");
} else {
  const script = fileURLToPath(new URL("./network-serial-pty-regression.py", import.meta.url));
  const r = spawnSync("python3", ["-B", script], {
    shell: false, windowsHide: true, encoding: "utf8", timeout: 15000,
    maxBuffer: 32 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error || r.status !== 0 || !r.stdout?.includes("NETWORK_SERIAL_PTY_ACCEPTANCE_PASS")) {
    console.error("NETWORK_SERIAL_PTY_GATE_FAILED", {
      exit: r.status, signal: r.signal, error: r.error?.code ?? null,
      stderr: r.stderr?.slice(0, 2000) ?? "",
    });
    process.exitCode = 1;
  } else {
    process.stdout.write(r.stdout);
    console.log("NETWORK_SERIAL_PTY_GATE_PASS");
  }
}
