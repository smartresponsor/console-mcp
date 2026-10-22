import assert from "node:assert/strict";
import {firewallInput,tcpConnectionsInput,cpuLoadInput,diskIoInput,servicesListInput,
 parseTcpConnections,parseCpuLoad,parseDiskStats,parseServiceList,parseFirewallChains
} from "../dist/tool/infrastructure-host-observations.js";

assert.deepEqual(firewallInput.parse({targetId:"local"}),{targetId:"local"});
assert.throws(()=>tcpConnectionsInput.parse({targetId:"local",limit:101}));
assert.throws(()=>tcpConnectionsInput.parse({targetId:"local",port:65536}));
assert.throws(()=>cpuLoadInput.parse({targetId:"remote"}));
assert.throws(()=>diskIoInput.parse({targetId:"local",command:"cat"}));
assert.equal(servicesListInput.parse({targetId:"local"}).limit,50);
const tcp="ESTAB 0 0 192.0.2.10:53333 198.51.100.5:443\n";
assert.deepEqual(parseTcpConnections(tcp),[{state:"ESTAB",localAddress:"192.0.2.10",localPort:53333,remoteAddress:"198.51.100.5",remotePort:443}]);
assert.equal(parseTcpConnections(tcp,22).length,0);
assert.equal(parseTcpConnections(tcp,443).length,1);
assert.equal(parseTcpConnections("LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\n").length,0);
assert.deepEqual(parseCpuLoad("0.40 1.20 2.00 2/250 1234\n"),{load1:0.4,load5:1.2,load15:2,running:2,tasks:250});
assert.equal(parseCpuLoad("unknown"),null);
assert.deepEqual(parseDiskStats("8 0 sda 10 0 20 30 40 0 50 60 0 70 0 0 0 0\n"),[
 {major:8,minor:0,device:"sda",readsCompleted:10,sectorsRead:20,writesCompleted:40,sectorsWritten:50,ioMilliseconds:70}
]);
assert.deepEqual(parseServiceList("ssh.service loaded active running OpenSSH\n"),[
 {unit:"ssh.service",load:"loaded",active:"active",sub:"running"}
]);
assert.deepEqual(parseFirewallChains("table inet filter {\n chain input {\n }\n chain forward {\n }\n }\n"),["input","forward"]);
assert.equal(JSON.stringify(parseFirewallChains("chain input {\n ip saddr 192.0.2.3 drop\n }")).includes("192.0.2.3"),false);
console.log("infrastructure host observations fixture contracts: PASS");
