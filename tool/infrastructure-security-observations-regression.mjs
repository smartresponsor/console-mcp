import assert from "node:assert/strict";
import {fdListInput,firewallPolicyInput,oomRecordsInput,journalDetailInput,
 parseFdEntries,parseNftPolicies,parseOomEvents,parseJournalDetail
} from "../dist/tool/infrastructure-security-observations.js";

assert.deepEqual(firewallPolicyInput.parse({targetId:"local"}),{targetId:"local"});
assert.throws(()=>fdListInput.parse({targetId:"local",pid:-1}));
assert.throws(()=>fdListInput.parse({targetId:"local",pid:1,limit:1000}));
assert.throws(()=>oomRecordsInput.parse({targetId:"local",minutes:1440}));
assert.throws(()=>journalDetailInput.parse({targetId:"local",cursor:"--since=all"}));
const fd=parseFdEntries("4\n0\n3\n2\n",3);
assert.deepEqual(fd,{descriptors:[0,2,3],observedCount:4,truncated:true});
const nft="table inet filter {\n chain input {\n type filter hook input priority 0; policy drop;\n ip saddr 192.0.2.3 accept\n }\n}\n";
assert.deepEqual(parseNftPolicies(nft),[{chain:"input",hook:"input",priority:"0",policy:"drop"}]);
assert.equal(JSON.stringify(parseNftPolicies(nft)).includes("192.0.2.3"),false);
const oom=parseOomEvents('{"MESSAGE":"Out of memory: Killed process 30","__REALTIME_TIMESTAMP":"123"}\n',10);
assert.deepEqual(oom.records,[{timestamp:"123",event:"out-of-memory"}]);
assert.equal(JSON.stringify(oom).includes("Killed process"),false);
const detail=parseJournalDetail('{"MESSAGE":"sensitive token=abc","PRIORITY":"3","_SYSTEMD_UNIT":"ssh.service","__REALTIME_TIMESTAMP":"123"}\n');
assert.deepEqual(detail,{timestamp:"123",unit:"ssh.service",severity:"3",messageRedacted:true});
assert.equal(JSON.stringify(detail).includes("token=abc"),false);
console.log("infrastructure security observation fixtures: PASS");
