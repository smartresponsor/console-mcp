import assert from "node:assert/strict";
import {normalizeInfraData} from "../dist/tool/infrastructure-normalization.js";
const list=normalizeInfraData("system.journal.record.list","windows",{records:[{
 cursor:"System:1234",timestamp:"2026-10-22T09:30:00Z",timestampUsec:null,priority:null,
 unit:"Service Control Manager",eventId:7036,level:4
}]});
assert.equal(list.records[0].cursor,"System:1234");
assert.equal(list.records[0].eventId,7036);
assert.equal(list.records[0].timestamp,"2026-10-22T09:30:00Z");
const detail=normalizeInfraData("system.journal.record.detail","windows",{record:{
 cursor:"System:1234",timestamp:"2026-10-22T09:30:00Z",severity:null,unit:"Service Control Manager",messageRedacted:true
}});
assert.equal(detail.record.cursor,"System:1234");
assert.equal(detail.record.timestamp,"2026-10-22T09:30:00Z");
assert.equal(detail.record.messageRedacted,true);
const state=normalizeInfraData("system.service.status","windows",{service:{Name:"Spooler",Status:4,StartType:2}});
assert.equal(state.state,"Running");
const services=normalizeInfraData("system.service.list","windows",{services:[{Name:"Spooler",Status:1,StartType:2}]});
assert.equal(services.services[0].state,"Stopped");
console.log("RC1 Windows normalization fixtures: PASS");
