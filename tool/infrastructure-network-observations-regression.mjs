import assert from "node:assert/strict";
import { interfaceInput, neighborInput, udpSocketsInput, dnsResolverInput,
  parseInterfaces, parseNeighbors, parseUdpSockets, parseResolverStatus,
} from "../dist/tool/infrastructure-network-observations.js";

for (const schema of [interfaceInput, neighborInput, dnsResolverInput]) {
  assert.deepEqual(schema.parse({targetId:"local"}),{targetId:"local"});
  assert.throws(()=>schema.parse({targetId:"remote"}));
}
assert.throws(()=>udpSocketsInput.parse({targetId:"local",port:0}));
assert.throws(()=>udpSocketsInput.parse({targetId:"local",limit:101}));
assert.deepEqual(parseInterfaces([{ifname:"eth0",ifindex:2,operstate:"UP",mtu:1500,addr_info:[
 {family:"inet",local:"192.0.2.10",prefixlen:24},{family:"inet6",local:"::1",prefixlen:128}
]}]),[{name:"eth0",index:2,state:"UP",mtu:1500,addresses:[{address:"192.0.2.10",prefixLength:24}]}]);
assert.deepEqual(parseNeighbors([{dst:"192.0.2.1",dev:"eth0",lladdr:"aa:bb:cc:dd:ee:ff",state:"REACHABLE"}]),[
 {address:"192.0.2.1",interface:"eth0",mac:"aa:bb:cc:dd:ee:ff",state:"REACHABLE"}]);
assert.deepEqual(parseUdpSockets("UNCONN 0 0 0.0.0.0:53 0.0.0.0:*\n"),[
 {address:"0.0.0.0",port:53,state:"UNCONN"}]);
assert.equal(parseUdpSockets("UNCONN 0 0 [::]:53 [::]:*\n",80).length,0);
assert.equal(parseUdpSockets("UNCONN 0 0 0.0.0.0:65536 0.0.0.0:*\n").length,0);
assert.deepEqual(parseResolverStatus("Current DNS Server: 192.0.2.1\nDNS Domain: example.test\n"),
 {servers:["192.0.2.1"],domains:["example.test"]});
console.log("infrastructure network observation fixtures: PASS");
