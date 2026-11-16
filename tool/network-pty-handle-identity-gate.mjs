/** Runs Linux kernel-only PTY FD identity regression (no real serial device). */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (process.platform !== "linux") {
  console.log("NETWORK_PTY_HANDLE_IDENTITY_SKIPPED_NON_LINUX");
} else {
  const file = fileURLToPath(new URL("./network-pty-handle-identity-regression.py", import.meta.url));
  const r = spawnSync("python3", ["-B", file], {
    shell:false, stdio:["ignore","pipe","pipe"], encoding:"utf8",
    timeout:10000, maxBuffer:32768, windowsHide:true,
  });
  if (r.error || r.status !== 0 || !r.stdout?.includes("NETWORK_PTY_HANDLE_IDENTITY_AND_CLEANUP_PASS")) {
    console.error("NETWORK_PTY_HANDLE_IDENTITY_GATE_FAILED", {
      exit:r.status, signal:r.signal, error:r.error?.code ?? null,
      stderr:r.stderr?.slice(0,2000) ?? "",
    });
    process.exitCode = 1;
  } else {
    process.stdout.write(r.stdout);
    console.log("NETWORK_PTY_HANDLE_IDENTITY_GATE_PASS");
  }
}
