import assert from "node:assert/strict";
import {parseJournalMetadata} from "../dist/tool/infrastructure-system-diagnostics.js";
import {normalizeInfraData} from "../dist/tool/infrastructure-normalization.js";
import {journalDetailInput} from "../dist/tool/infrastructure-security-observations.js";

const cursor="s=abc;i=1;b=deadbeef;m=123;t=456;x=789";
const payload=JSON.stringify({__CURSOR:cursor,__REALTIME_TIMESTAMP:"123",PRIORITY:"4",_SYSTEMD_UNIT:"ssh.service",MESSAGE:"private"});
const list=parseJournalMetadata(payload+"\n",10);
assert.equal(list.records[0].cursor,cursor);
assert.equal(JSON.stringify(list).includes("private"),false);
assert.equal(journalDetailInput.parse({targetId:"local",cursor}).cursor,cursor);
assert.throws(()=>journalDetailInput.parse({targetId:"local",cursor:"bad cursor"}));
assert.deepEqual(normalizeInfraData("system.journal.record.list","linux",{records:list.records}),{
 records:[{cursor,timestampUsec:"123",priority:"4",unit:"ssh.service"}]
});
console.log("journal locator contract fixtures: PASS");
