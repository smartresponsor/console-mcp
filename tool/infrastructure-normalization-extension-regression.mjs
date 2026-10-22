import assert from "node:assert/strict";
import {normalizeInfraData} from "../dist/tool/infrastructure-normalization.js";
import {windowsProcessesInput} from "../dist/tool/infrastructure-windows-observations.js";
assert.deepEqual(normalizeInfraData("dns.resolver.inspect","linux",{resolver:{servers:["192.0.2.53"],domains:["example.test"]}}),
 {resolverAddresses:["192.0.2.53"],searchDomains:["example.test"]});
assert.deepEqual(normalizeInfraData("dns.resolver.inspect","windows",{interfaces:[{ServerAddresses:["192.0.2.53"]},{ServerAddresses:["192.0.2.53","198.51.100.53"]}]}),
 {resolverAddresses:["192.0.2.53","198.51.100.53"],searchDomains:[]});
assert.deepEqual(normalizeInfraData("system.process.detail","windows",{process:{ProcessId:41,ParentProcessId:4,Name:"worker.exe",WorkingSetSize:4096}}),
 {pid:41,ppid:4,name:"worker.exe",state:null,rssBytes:4096});
assert.deepEqual(normalizeInfraData("system.service.status","linux",{service:{Id:"ssh.service",ActiveState:"active",SubState:"running",MainPID:10,UnitFileState:"enabled"}}),
 {id:"ssh.service",state:"active",subState:"running",pid:10,startType:"enabled"});
assert.equal(windowsProcessesInput.parse({targetId:"local"}).limit,50);
assert.throws(()=>windowsProcessesInput.parse({targetId:"local",limit:0}));
console.log("cross-platform normalization extension fixtures: PASS");
