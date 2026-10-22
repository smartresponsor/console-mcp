// Feature-branch fixtures; execution deferred until the consolidated verification phase.
import assert from "node:assert/strict";
import {
  memoryStatusInput, processDetailInput, serviceStatusInput, journalRecordsInput,
  parseMemoryInfo, parseServiceProperties, parseProcessProperties, parseJournalMetadata,
} from "../dist/tool/infrastructure-system-diagnostics.js";

assert.deepEqual(memoryStatusInput.parse({ targetId: "local" }), { targetId: "local" });
assert.throws(() => processDetailInput.parse({ targetId: "local", pid: -1 }));
assert.throws(() => serviceStatusInput.parse({ targetId: "local", serviceId: "ssh.service;id" }));
assert.throws(() => journalRecordsInput.parse({ targetId: "local", minutes: 1000 }));
assert.deepEqual(parseMemoryInfo("MemTotal: 1000 kB\nMemAvailable: 300 kB\nSecret: 4 kB\n"), {
  MemTotal: 1024000, MemAvailable: 307200,
});
assert.deepEqual(parseServiceProperties("Id=ssh.service\nActiveState=active\nMainPID=47\nEnvironment=SECRET\n"), {
  Id: "ssh.service", ActiveState: "active", MainPID: 47,
});
assert.deepEqual(parseProcessProperties("123 1 S 512 myworker"), {
  pid: 123, ppid: 1, state: "S", rssBytes: 524288, name: "myworker",
});
const journal = parseJournalMetadata('{"__REALTIME_TIMESTAMP":"123456","PRIORITY":"4","_SYSTEMD_UNIT":"ssh.service","MESSAGE":"sensitive"}\n', 10);
assert.equal(journal.records.length, 1);
assert.equal(JSON.stringify(journal).includes("sensitive"), false);
console.log("infrastructure system diagnostics fixtures: PASS");
