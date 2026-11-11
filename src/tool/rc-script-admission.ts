/** Exact, reviewed RC script definitions. Fail closed on renames or command drift. */
export const admittedRcNpmScripts: Readonly<Record<string, string>> = Object.freeze({
  "build": "tsc -p tsconfig.json",
  "smoke": "npm run build && node tool/smoke-test.mjs",
  "schema:validate": "node tool/console-registration-ast-regression.mjs && node tool/validate-console-tool-catalog.mjs && node tool/validate-capability-admission.mjs && node tool/validate-capability-admission-diff.mjs && node tool/chatgpt-adopt-schema-regression.mjs && node tool/chatgpt-connector-refresh-regression.mjs && node tool/web-capability-bridge-regression.mjs && node tool/web-outcome-policy-regression.mjs && node tool/web-domain-bridge-regression.mjs && node tool/browser-facade-projection-regression.mjs && node tool/rc-validation-scope-regression.mjs && node tool/rc-validation-profile-live-regression.mjs && node tool/rc-script-admission-regression.mjs",
  "test:visible-session": "npm run build && node tool/visible-browser-session-regression.mjs && node tool/browser-prompt-supervisor-regression.mjs && node tool/windows-passive-status-regression.mjs && node tool/windows-cdp-readiness-regression.mjs && node tool/windows-foreground-regression.mjs && node tool/windows-native-session-regression.mjs && node tool/visible-worker-boundary-regression.mjs",
  "test:release-transaction": "npm run build && node tool/release-transaction-tools-regression.mjs && python3 -I ops/ubuntu/deployment/release-broker-regression.py",
  "test:deployment-preflight": "pwsh -NoProfile -File tool/runtime-deployment-preflight-regression.ps1",
});
export function rcScriptEligible(family: "composer" | "npm", script: string): boolean {
  if (family === "npm" && Object.hasOwn(admittedRcNpmScripts, script)) return true;
  if (/fix|write|reset|drop|delete|migrate|load|seed|fixture|install|update|deploy|start|restart|serve|watch|dev/i.test(script)) return false;
  return family === "composer"
    ? /^(test|test:|lint|lint:|analyse|analyze|check|check:|phpstan|stan|canon|canon:|owner:canon:enforce|pipeline:local:full|gating:|ai-review:|inspect:|smoke|smoke:)/i.test(script)
    : /^(test|test:|typecheck|ui:check|build|lint|lint:|check|check:|schema:validate|smoke|smoke:)/i.test(script);
}
export function rcScriptAdmission(family: "composer" | "npm", script: string, definition?: string): "admitted" | "review_required" {
  if (family !== "npm" || typeof definition !== "string") return "review_required";
  return Object.hasOwn(admittedRcNpmScripts, script) && admittedRcNpmScripts[script] === definition
    ? "admitted" : "review_required";
}
