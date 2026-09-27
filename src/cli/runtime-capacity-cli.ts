import path from "node:path";
import { readRuntimeCapacity, runtimeCapacityAllowsHeavyWork, runtimeCapacityAllowsNewWork } from "../service/runtime-capacity.js";

const args = process.argv.slice(2);
const rootArg = args.find((arg) => arg.startsWith("--project-root="));
const projectRoot = path.resolve(rootArg ? rootArg.slice("--project-root=".length) : process.cwd());
const requireHeavy = args.includes("--require-heavy");
const requireNewWork = args.includes("--require-new-work");
const capacity = readRuntimeCapacity(projectRoot);
const requirement = requireHeavy ? "heavy" : (requireNewWork ? "new_work" : "none");
const allowed = requireHeavy
  ? runtimeCapacityAllowsHeavyWork(capacity)
  : (requireNewWork ? runtimeCapacityAllowsNewWork(capacity) : true);

process.stdout.write(`${JSON.stringify({ ...capacity, requirement, requirement_allowed: allowed })}\n`);
if (!allowed) process.exitCode = 3;
