#!/usr/bin/env node
import { cleanupQuarantine } from '../runtime/web-secret-cleanup.mjs';
try {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--operation-id' || args[2] !== '--acknowledge') throw Error();
  console.log(JSON.stringify(await cleanupQuarantine({ operationId: args[1], acknowledge: args[3] })));
} catch {
  console.error('{"ok":false,"status":"WEB_SECRET_CLEANUP_DENIED"}');
  process.exitCode = 1;
}
