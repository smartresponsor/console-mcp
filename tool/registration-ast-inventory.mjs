import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanConsoleRegistrations } from "./console-registration-ast.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = await scanConsoleRegistrations(root);
process.stdout.write(JSON.stringify({
  registrationCount: result.registrations.length,
  registeredNameCount: result.registeredNames.length,
  legacyPairCount: result.legacyPairs.length,
  unresolvedCount: result.unresolved.length,
  unresolved: result.unresolved,
}, null, 2) + "\n");
