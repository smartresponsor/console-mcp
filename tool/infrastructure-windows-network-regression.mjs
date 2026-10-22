import assert from "node:assert/strict";
import {
 winTcpListenersInput,winTcpConnectionsInput,winUdpSocketsInput,winDnsInput,winFirewallInput,
 decodeRecords,restrictPorts
} from "../dist/tool/infrastructure-windows-network.js";
for(const schema of [winTcpListenersInput,winTcpConnectionsInput,winUdpSocketsInput]){
 assert.equal(schema.parse({targetId:"local"}).limit,50);
 assert.throws(()=>schema.parse({targetId:"local",port:0}));
 assert.throws(()=>schema.parse({targetId:"local",limit:101}));
}
assert.throws(()=>winDnsInput.parse({targetId:"remote"}));
assert.throws(()=>winFirewallInput.parse({targetId:"local",command:"Disable-NetFirewallProfile"}));
assert.deepEqual(decodeRecords('{"LocalPort":443,"State":"Listen"}'),[{LocalPort:443,State:"Listen"}]);
assert.deepEqual(decodeRecords('[{"LocalPort":80},{"LocalPort":443}]'),[{LocalPort:80},{LocalPort:443}]);
assert.deepEqual(decodeRecords('null'),[]);
assert.equal(decodeRecords('not-json'),null);
const rows=[{LocalPort:53333,RemotePort:443},{LocalPort:80,RemotePort:0}];
assert.deepEqual(restrictPorts(rows,443),[rows[0]]);
assert.deepEqual(restrictPorts(rows,80),[rows[1]]);
assert.equal(restrictPorts(rows,22).length,0);
console.log("Windows infrastructure network fixtures: PASS");
