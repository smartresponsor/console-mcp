import { inspectVisibleTarget } from "../service/visible-browser-session.js";
const targetId = process.argv[2];
if (!/^[A-Fa-f0-9]{32}$/.test(targetId ?? "") || process.getuid?.() !== 1000) process.exit(64);
console.log(JSON.stringify(await inspectVisibleTarget({ port: 9224, targetId })));
