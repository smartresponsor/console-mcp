import assert from "node:assert/strict";
import {windowsMemoryInput,windowsCpuInput,windowsInterfacesInput,windowsRoutesInput,
 windowsServicesInput,windowsProcessInput,windowsServiceInput,parsePsJson
} from "../dist/tool/infrastructure-windows-observations.js";
for(const schema of [windowsMemoryInput,windowsCpuInput,windowsInterfacesInput,windowsRoutesInput]){
 assert.deepEqual(schema.parse({targetId:"local"}),{targetId:"local"});
 assert.throws(()=>schema.parse({targetId:"remote"}));
}
assert.throws(()=>windowsProcessInput.parse({targetId:"local",pid:0}));
assert.throws(()=>windowsServicesInput.parse({targetId:"local",limit:1000}));
assert.throws(()=>windowsServiceInput.parse({targetId:"local",serviceId:"Spooler'; Remove-Item C:\\"}));
assert.deepEqual(parsePsJson('{"Name":"Spooler","Status":4}'),{Name:"Spooler",Status:4});
assert.deepEqual(parsePsJson('[{"InterfaceAlias":"Ethernet","IPAddress":"192.0.2.2"}]'),[
 {InterfaceAlias:"Ethernet",IPAddress:"192.0.2.2"}
]);
assert.equal(parsePsJson("not-json"),null);
console.log("Windows infrastructure adapter fixtures: PASS");
