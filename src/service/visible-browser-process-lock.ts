import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

// Kernel-held locks are released when the helper exits, including on parent crash.
// A shared instance lock permits independent target operations; browser-wide
// operations take the exclusive instance lock. Target locks are always exclusive.
const helper = String.raw`import fcntl, os, sys
instance_path, target_path, mode = sys.argv[1:]
fds=[]
try:
    fd=os.open(instance_path, os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW, 0o600)
    fds.append(fd)
    fcntl.flock(fd, (fcntl.LOCK_EX if mode=="browser" else fcntl.LOCK_SH)|fcntl.LOCK_NB)
    if mode=="target":
        fd=os.open(target_path, os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW, 0o600)
        fds.append(fd)
        fcntl.flock(fd, fcntl.LOCK_EX|fcntl.LOCK_NB)
    sys.stdout.write("ACQUIRED\n")
    sys.stdout.flush()
    sys.stdin.buffer.read()
except BlockingIOError:
    sys.stdout.write("BUSY\n")
    sys.stdout.flush()
except Exception:
    sys.stdout.write("UNAVAILABLE\n")
    sys.stdout.flush()`;

export type ProcessLease = { ok: true; isHeld: () => boolean; release: () => Promise<void> } |
  { ok: false; reason: "CROSS_PROCESS_LEASE_BUSY" | "CROSS_PROCESS_LEASE_UNAVAILABLE" };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export async function acquireVisibleProcessLease(instanceKey: string, level: "browser" | "target", targetId: string | null): Promise<ProcessLease> {
  if (process.platform !== "linux" || !instanceKey || (level === "target" && !/^[a-f0-9]{32}$/i.test(targetId ?? "")))
    return { ok: false, reason: "CROSS_PROCESS_LEASE_UNAVAILABLE" };
  const uid = process.getuid?.();
  if (uid === undefined) return { ok: false, reason: "CROSS_PROCESS_LEASE_UNAVAILABLE" };
  const root = process.env.CONSOLE_MCP_VISIBLE_LEASE_ROOT ?? join(tmpdir(), `console-mcp-visible-leases-${uid}`);
  try {
    if (!isAbsolute(root)) throw Error("relative lease root");
    mkdirSync(root, { mode: 0o700, recursive: true });
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077)) throw Error("insecure lease root");
  } catch { return { ok: false, reason: "CROSS_PROCESS_LEASE_UNAVAILABLE" }; }
  const instancePath = join(root, `${digest(instanceKey)}.instance.lock`);
  const targetPath = level === "target" ? join(root, `${digest(instanceKey + ":" + targetId)}.target.lock`) : "-";
  return await new Promise<ProcessLease>(resolve => {
    let finished = false;
    let output = "";
    const child: ChildProcessWithoutNullStreams = spawn("/usr/bin/python3", ["-u", "-c", helper, instancePath, targetPath, level],
      { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } });
    const finish = (result: ProcessLease) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => { child.kill(); finish({ ok: false, reason: "CROSS_PROCESS_LEASE_UNAVAILABLE" }); }, 3000);
    child.stdout.on("data", chunk => {
      output += String(chunk);
      if (output.length > 64) { child.kill(); finish({ ok: false, reason: "CROSS_PROCESS_LEASE_UNAVAILABLE" }); return; }
      if (output.includes("ACQUIRED\n")) {
        finish({ ok: true, isHeld: () => child.exitCode === null && child.signalCode === null && !child.killed, release: () => new Promise<void>(done => {
          if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
          child.once("close", () => done());
          child.stdin.end();
          setTimeout(() => child.kill(), 1000).unref();
        }) });
      } else if (output.includes("BUSY\n")) { child.kill(); finish({ ok: false, reason: "CROSS_PROCESS_LEASE_BUSY" }); }
      else if (output.includes("UNAVAILABLE\n")) { child.kill(); finish({ ok: false, reason: "CROSS_PROCESS_LEASE_UNAVAILABLE" }); }
    });
    child.on("error", () => finish({ ok: false, reason: "CROSS_PROCESS_LEASE_UNAVAILABLE" }));
    child.on("close", () => finish({ ok: false, reason: "CROSS_PROCESS_LEASE_UNAVAILABLE" }));
  });
}
