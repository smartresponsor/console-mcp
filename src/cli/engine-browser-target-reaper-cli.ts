import path from "node:path";
import { reapReadyEngineBrowserTargets } from "../service/engine-browser-target-reaper.js";

const args = process.argv.slice(2);
const rootArg = args.find((arg) => arg.startsWith("--root="));
const portsArg = args.find((arg) => arg.startsWith("--ports="));
const maxCloseArg = args.find((arg) => arg.startsWith("--max-close="));
const timeoutArg = args.find((arg) => arg.startsWith("--timeout-ms="));
const root = path.resolve(rootArg ? rootArg.slice("--root=".length) : process.cwd());
const ports = portsArg ? portsArg.slice("--ports=".length).split(",").map((v) => Number.parseInt(v.trim(),10)).filter((v) => Number.isInteger(v)) : undefined;
const maxClose = maxCloseArg ? Number.parseInt(maxCloseArg.slice("--max-close=".length),10) : undefined;
const timeoutMs = timeoutArg ? Number.parseInt(timeoutArg.slice("--timeout-ms=".length),10) : undefined;
const result = await reapReadyEngineBrowserTargets({ root, ports, maxClose, timeoutMs });
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.ok !== true) process.exitCode = 2;
