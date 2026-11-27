import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = "/proc";
const profile = "/var/lib/console-mcp-browser/edge-profile";
const executable = "/opt/microsoft/msedge/msedge";
const group = "0::/system.slice/console-mcp-browser.service";

export type IsolatedCdpSocketProof =
  | { ok: true; reason: "ISOLATED_CDP_SOCKET_VERIFIED"; pid: number; started: string; profile: string }
  | { ok: false; reason: string };

type Reader = {
  socket: () => Promise<string>;
  read: (path: string) => Promise<string>;
  link: (path: string) => Promise<string>;
  identity: () => { uid: number; username: string };
};

const reader: Reader = {
  socket: async () => (await exec("/usr/bin/ss", ["-H", "-ltnpe", "sport = :9223"], {
    timeout: 2500, maxBuffer: 65536, env: { ...process.env, LC_ALL: "C" },
  })).stdout,
  read: path => readFile(path, "utf8"),
  link: path => readlink(path),
  identity: () => { const u = userInfo(); return { uid: u.uid, username: u.username }; },
};

export function parseIsolatedCdpListener(output: string) {
  const rows = output.trim().split(/\r?\n/).filter(Boolean);
  if (rows.length !== 1) return null;
  const row = rows[0];
  if (!/^LISTEN\s+\d+\s+\d+\s+127\.0\.0\.1:9223\s+0\.0\.0\.0:\*\s/.test(row)) return null;
  const owners = [...row.matchAll(/pid=(\d+),fd=(\d+)/g)];
  const uids = [...row.matchAll(/(?:^|\s)uid:(\d+)(?=\s|$)/g)];
  const inodes = [...row.matchAll(/(?:^|\s)ino:(\d+)(?=\s|$)/g)];
  if (owners.length !== 1 || uids.length !== 1 || inodes.length !== 1 ||
      !/users:\(\("msedge",pid=\d+,fd=\d+\)\)/.test(row)) return null;
  const pid = Number(owners[0][1]), fd = Number(owners[0][2]), uid = Number(uids[0][1]);
  if (![pid, fd, uid].every(Number.isSafeInteger) || pid <= 1 || fd < 0 || uid <= 0 || inodes[0][1] === "0") return null;
  return { pid, fd, uid, inode: inodes[0][1] };
}

function processStart(stat: string, pid: number) {
  if (!stat.startsWith(pid + " (msedge) ")) return null;
  const start = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
  return /^\d+$/.test(start ?? "") && start !== "0" ? start : null;
}

// Exact Gold worker only. The kernel listener, proc fd, service cgroup,
// service UID, executable and start identity must all agree twice.
// Never infer ownership from a CDP port, argv, or a PID alone.
export async function inspectIsolatedCdpSocket(io: Reader = reader): Promise<IsolatedCdpSocketProof> {
  const deny = (reason: string): IsolatedCdpSocketProof => ({ ok: false, reason });
  try {
    const self = io.identity();
    if (self.username !== "console-mcp" || !Number.isSafeInteger(self.uid) || self.uid <= 0)
      return deny("ISOLATED_CDP_SERVICE_IDENTITY_UNVERIFIED");
    const first = parseIsolatedCdpListener(await io.socket());
    if (!first || first.uid !== self.uid) return deny("ISOLATED_CDP_LISTENER_UNVERIFIED");
    const base = root + "/" + first.pid;
    const [stat, status, cgroup, raw, exe, fd] = await Promise.all([
      io.read(base + "/stat"), io.read(base + "/status"), io.read(base + "/cgroup"),
      io.read(base + "/cmdline"), io.link(base + "/exe"), io.link(base + "/fd/" + first.fd),
    ]);
    const started = processStart(stat, first.pid);
    const uids = status.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m)?.slice(1);
    const args = raw.trim().replace(/\0+$/, "").includes("\0") ? raw.replace(/\0+$/, "").split("\0") : raw.trim().split(/\s+/);
    if (!started || !uids || uids.some(uid => Number(uid) !== self.uid) ||
        cgroup.trim() !== group || fd !== "socket:[" + first.inode + "]" ||
        args.some(arg => arg.startsWith("--type=")) ||
        args.filter(arg => arg.startsWith("--remote-debugging-port=")).join() !== "--remote-debugging-port=9223" ||
        args.filter(arg => arg.startsWith("--user-data-dir=")).join() !== "--user-data-dir=" + profile)
      return deny("ISOLATED_CDP_PROCESS_UNVERIFIED");
    // A replaced/deleted executable needs an operator-controlled lifecycle
    // transition. Do not silently authorize a stale running binary.
    if (exe === executable + " (deleted)") return deny("ISOLATED_CDP_EXECUTABLE_REPLACED");
    if (exe !== executable) return deny("ISOLATED_CDP_EXECUTABLE_UNVERIFIED");
    const [secondRaw, lastStat, lastFd, lastExe, lastGroup, lastStatus, lastArgs] = await Promise.all([
      io.socket(), io.read(base + "/stat"), io.link(base + "/fd/" + first.fd), io.link(base + "/exe"),
      io.read(base + "/cgroup"), io.read(base + "/status"), io.read(base + "/cmdline"),
    ]);
    const second = parseIsolatedCdpListener(secondRaw);
    if (!second || JSON.stringify(first) !== JSON.stringify(second) ||
        processStart(lastStat, first.pid) !== started || lastFd !== fd ||
        lastExe !== exe || lastGroup !== cgroup || lastArgs !== raw ||
        lastStatus.match(/^Uid:.*$/m)?.[0] !== status.match(/^Uid:.*$/m)?.[0])
      return deny("ISOLATED_CDP_IDENTITY_CHANGED");
    return { ok: true, reason: "ISOLATED_CDP_SOCKET_VERIFIED", pid: first.pid, started, profile };
  } catch { return deny("ISOLATED_CDP_EVIDENCE_UNAVAILABLE"); }
}
