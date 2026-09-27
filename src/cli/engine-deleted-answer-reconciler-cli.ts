import { reconcileIrrecoverableDeletedAnswerCaptureTasks } from "../service/engine-deleted-answer-reconciler.js";

const args = process.argv.slice(2);
const rootArg = args.find((arg) => arg.startsWith("--root="));
const maxWorkArg = args.find((arg) => arg.startsWith("--max-work="));
const root = rootArg ? rootArg.slice("--root=".length) : process.cwd();
const maxWork = maxWorkArg ? Number.parseInt(maxWorkArg.slice("--max-work=".length), 10) : 20;

const result = await reconcileIrrecoverableDeletedAnswerCaptureTasks({ root, maxWork });
process.stdout.write(JSON.stringify(result) + "\n");
if (result.ok !== true) process.exitCode = 1;
