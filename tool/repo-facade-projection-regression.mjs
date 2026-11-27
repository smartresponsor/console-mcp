import assert from "node:assert/strict";
import { REPO_FACADE_TOOL_NAMES, OWNER_REPO_FACADE_TOOL_NAMES, repoFacadeToolNames, ownerRepoFacadeToolNames, excludeOwnerRepositoryTools } from "../dist/engine/repo-facade-tools.js";
const canonical = new Set([...OWNER_REPO_FACADE_TOOL_NAMES, "read_.system.console.describe"]);
const admitted = new Set(OWNER_REPO_FACADE_TOOL_NAMES);
assert.equal(repoFacadeToolNames(canonical, admitted).size,8);
assert.deepEqual([...repoFacadeToolNames(canonical,admitted)], [...REPO_FACADE_TOOL_NAMES]);
assert.equal(ownerRepoFacadeToolNames(canonical, admitted).size,39);
const full = ownerRepoFacadeToolNames(canonical,admitted,true);
assert.equal(full.size,41);
assert.deepEqual([...full], [...OWNER_REPO_FACADE_TOOL_NAMES]);
assert.equal(full.has("read_.system.console.describe"),false);
for(const name of REPO_FACADE_TOOL_NAMES) assert.ok(full.has(name));
for(const fn of [repoFacadeToolNames,ownerRepoFacadeToolNames]) {
 assert.throws(()=>fn(new Set(),admitted), /unregistered or unadmitted/);
 assert.throws(()=>fn(canonical,new Set()), /unregistered or unadmitted/);
}
const registry={forConsumerIncluding(consumer,names){return {consumer,toolNames:names,toolCount:names.size};}};
for(const consumer of ["chatgpt","codex","runner"]) {
 const projection=excludeOwnerRepositoryTools(registry,{consumer,toolNames:canonical});
 assert.deepEqual([...projection.toolNames],["read_.system.console.describe"]);
}
console.log("ENG16_M5_ROUTE_PROJECTION_DELTA_PASS");
