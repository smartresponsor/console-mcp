import assert from "node:assert/strict";
import { inspectIsolatedCdpSocket, parseIsolatedCdpListener } from "../dist/service/isolated-cdp-socket-proof.js";
const row = 'LISTEN 0 10 127.0.0.1:9223 0.0.0.0:* users:(("msedge",pid=1775,fd=84)) uid:993 ino:20601 sk:1 cgroup:unreachable:16cb <->';
const stat = "1775 (msedge) " + ["S", ...Array(18).fill("0"), "1478", "0"].join(" ");
const values = {
  stat,
  status: "Name:\tmsedge\nUid:\t993\t993\t993\t993\n",
  cgroup: "0::/system.slice/console-mcp-browser.service\n",
  cmdline: "edge title --remote-debugging-port=9223 --user-data-dir=/var/lib/console-mcp-browser/edge-profile",
  exe: "/opt/microsoft/msedge/msedge",
  "fd/84": "socket:[20601]",
};
const fixture = (overrides = {}, sockets = [row]) => {
  let i = 0;
  const v = { ...values, ...overrides };
  return { socket: async () => sockets[Math.min(i++, sockets.length - 1)],
    read: async p => v[p.replace("/proc/1775/", "")],
    link: async p => v[p.replace("/proc/1775/", "")],
    identity: () => ({ uid: 993, username: "console-mcp" }) };
};
assert.equal(parseIsolatedCdpListener(row).inode, "20601");
for (const text of [row+"\n"+row,row.replace("127.0.0.1","0.0.0.0"),row.replace("uid:993",""),row.replace('pid=1775,fd=84','pid=1775,fd=84),("msedge",pid=1776,fd=85')])
  assert.equal(parseIsolatedCdpListener(text), null);
assert.deepEqual(await inspectIsolatedCdpSocket(fixture()), { ok: true, reason: "ISOLATED_CDP_SOCKET_VERIFIED", pid: 1775, started: "1478", profile: "/var/lib/console-mcp-browser/edge-profile" });
for (const [change, reason] of [
  [{ exe: values.exe+" (deleted)" }, "ISOLATED_CDP_EXECUTABLE_REPLACED"],
  [{ exe: "/tmp/msedge" }, "ISOLATED_CDP_EXECUTABLE_UNVERIFIED"],
  [{ cgroup: "0::/other.service" }, "ISOLATED_CDP_PROCESS_UNVERIFIED"],
  [{ "fd/84": "socket:[999]" }, "ISOLATED_CDP_PROCESS_UNVERIFIED"],
  [{ status: values.status.replaceAll("993","1000") }, "ISOLATED_CDP_PROCESS_UNVERIFIED"],
  [{ cmdline: values.cmdline+" --remote-debugging-port=9999" }, "ISOLATED_CDP_PROCESS_UNVERIFIED"],
]) assert.deepEqual(await inspectIsolatedCdpSocket(fixture(change)), { ok: false, reason });
assert.equal((await inspectIsolatedCdpSocket(fixture({}, [row,row.replace("ino:20601","ino:20602")]))).reason,"ISOLATED_CDP_IDENTITY_CHANGED");
console.log("isolated CDP socket proof regression: PASS");
if (process.argv.includes("--live-readonly")) console.log(JSON.stringify({ live: await inspectIsolatedCdpSocket() }));
