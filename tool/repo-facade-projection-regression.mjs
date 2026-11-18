import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { REPO_FACADE_TOOL_NAMES, repoFacadeToolNames } from "../dist/engine/repo-facade-tools.js";

const canonical = new Set([...REPO_FACADE_TOOL_NAMES, "read_.system.console.describe"]);
const admitted = new Set(REPO_FACADE_TOOL_NAMES);
const projection = repoFacadeToolNames(canonical, admitted);
assert.deepEqual([...projection], [...REPO_FACADE_TOOL_NAMES]);
assert.equal(projection.has("read_.system.console.describe"), false);
assert.equal(projection.size, 9);
assert.equal(projection.has("write.repo.git.push.current.set.upstream"), true);
assert.equal(projection.has("write.repo.git.push.current"), false);
assert.throws(() => repoFacadeToolNames(new Set(), admitted), /unregistered or unadmitted/);
assert.throws(() => repoFacadeToolNames(canonical, new Set()), /unregistered or unadmitted/);
// Guard the cutover and planner wiring against accidental alias regression.
const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const plannerSource = readFileSync(new URL("../src/tool/git-inspection.ts", import.meta.url), "utf8");
assert.match(indexSource, /CONSOLE_MCP_REPO_MAIN_PROJECTION_CUTOVER/);
assert.match(indexSource, /canonicalRegistry\.forConsumerExcluding\("chatgpt"/);
assert.match(indexSource, /consumerProjections\.chatgpt = canonicalRegistry\.forConsumerExcluding/);
assert.doesNotMatch(indexSource, /consumerProjections\.(?:codex|runner) = canonicalRegistry\.forConsumerExcluding/);
const registrySource = readFileSync(new URL("../src/engine/canonical-tool-registry.ts", import.meta.url), "utf8");
assert.match(registrySource, /forConsumerExcluding\(consumer: ConsumerName/);
assert.match(registrySource, /descriptor\.consumers\[consumer\] && !excludedNames\.has/);
assert.ok(indexSource.indexOf("const repoFacadeProjection:") < indexSource.indexOf("canonicalRegistry.forConsumerExcluding"));
assert.match(plannerSource, /executeTool = "write\.repo\.git\.push\.current\.branch"/);
assert.match(plannerSource, /executeTool = "write\.repo\.git\.push\.current\.set\.upstream"/);
console.log("repo facade projection: PASS");
