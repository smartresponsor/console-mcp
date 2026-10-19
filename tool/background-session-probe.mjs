import { inspectIsolatedBackground } from '../src/service/isolated-background-session.ts';
const result=await inspectIsolatedBackground();
console.log(JSON.stringify(result));
