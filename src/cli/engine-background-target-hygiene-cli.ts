import { runEngineBackgroundTargetHygiene } from "../service/engine-background-target-hygiene.js";

const args = process.argv.slice(2);
const rootArg = args.find((arg) => arg.startsWith("--root="));
const portsArg = args.find((arg) => arg.startsWith("--ports="));
const maxCloseArg = args.find((arg) => arg.startsWith("--max-close="));
const timeoutArg = args.find((arg) => arg.startsWith("--timeout-ms="));

const root = rootArg ? rootArg.slice("--root=".length) : process.cwd();
const ports = portsArg
  ? portsArg.slice("--ports=".length).split(",").map((value) => Number.parseInt(value, 10)).filter((value) => Number.isInteger(value))
  : [9223];
const maxClose = maxCloseArg ? Number.parseInt(maxCloseArg.slice("--max-close=".length), 10) : 3;
const timeoutMs = timeoutArg ? Number.parseInt(timeoutArg.slice("--timeout-ms=".length), 10) : 3000;

const result = await runEngineBackgroundTargetHygiene({ root, ports, maxClose, timeoutMs });
process.stdout.write(JSON.stringify(result) + "\n");
if (result.ok !== true) process.exitCode = 1;
