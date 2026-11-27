import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// Kernel-held locks are released when the helper exits, including on parent crash.
// A shared instance lock permits independent target operations; browser-wide
// operations take the exclusive instance lock. Target locks are always exclusive.
const helper = String.raw`import fcntl, os, stat, sys
instance_path, target_path, mode = sys.argv[1:]
fds=[]
def checked_open(path):
    fd=os.open(path, os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK, 0o600)
    fds.append(fd)
    st=os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or st.st_nlink!=1 or st.st_mode & 0o077:
        raise ValueError("insecure lock inode")
    return fd
try:
    fd=checked_open(instance_path)
    fcntl.flock(fd, (fcntl.LOCK_EX if mode=="browser" else fcntl.LOCK_SH)|fcntl.LOCK_NB)
    if mode=="target":
        fd=checked_open(target_path)
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
// The peer must witness the same directory inode, not merely the same path.
export function inspectVisibleProcessLeaseRoot(): { path: string; identity: string } | null {
  const root = process.env.CONSOLE_MCP_VISIBLE_LEASE_ROOT;
  const uid = process.getuid?.();
  if (!root || uid === undefined) return null;
  try {
    if (!isAbsolute(root) || realpathSync(root) !== root) return null;
    const stat = lstatSync(root, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(uid) || (stat.mode & 0o077n)) return null;
    return { path: root, identity: `${stat.dev}:${stat.ino}` };
  } catch { return null; }
}
export async function acquireVisibleProcessLease(instanceKey: string, level: "browser" | "target", targetId: string | null): Promise<ProcessLease> {
  if (process.platform !== "linux" || !instanceKey || (level === "target" && !/^[a-f0-9]{32}$/i.test(targetId ?? "")))
    return { ok: false, reason: "CROSS_PROCESS_LEASE_UNAVAILABLE" };
  const uid = process.getuid?.();
  if (uid === undefined) return { ok: false, reason: "CROSS_PROCESS_LEASE_UNAVAILABLE" };
  const root = inspectVisibleProcessLeaseRoot();
  if (!root) return { ok: false, reason: "CROSS_PROCESS_LEASE_UNAVAILABLE" };
  const instancePath = join(root.path, `${digest(instanceKey)}.instance.lock`);
  const targetPath = level === "target" ? join(root.path, `${digest(instanceKey + ":" + targetId)}.target.lock`) : "-";
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
    child.stdin.on("error", () => {});
    child.stderr.resume();
    child.on("error", () => finish({ ok: false, reason: "CROSS_PROCESS_LEASE_UNAVAILABLE" }));
    child.on("close", () => finish({ ok: false, reason: "CROSS_PROCESS_LEASE_UNAVAILABLE" }));
  });
}

type HeldLease = Extract<ProcessLease, { ok: true }>;
type LeaseScope = { key: string; lease: HeldLease; active: boolean };
const leaseScope = new AsyncLocalStorage<LeaseScope>();

// Reuse only an in-process, live lease object. No caller header or env flag
// can manufacture ownership, and inherited async work cannot reuse it after exit.
export async function runWithHeldVisibleProcessLease<T>(key: string, lease: HeldLease, run: () => Promise<T>): Promise<T> {
  if (!lease.isHeld()) throw new Error("CROSS_PROCESS_LEASE_UNAVAILABLE");
  const scope = { key, lease, active: true };
  try {
    const result = await leaseScope.run(scope, run);
    if (!lease.isHeld()) throw new Error("CROSS_PROCESS_LEASE_LOST");
    return result;
  } finally { scope.active = false; }
}

export async function withVisibleProcessLease<T>(key: string, run: () => Promise<T>): Promise<T> {
  const current = leaseScope.getStore();
  if (current) {
    if (!current.active || current.key !== key || !current.lease.isHeld())
      throw new Error("CROSS_PROCESS_LEASE_SCOPE_INVALID");
    return await run();
  }
  const lease = await acquireVisibleProcessLease(key, "browser", null);
  if (!lease.ok) throw new Error(lease.reason);
  try { return await runWithHeldVisibleProcessLease(key, lease, run); }
  finally { await lease.release(); }
}
