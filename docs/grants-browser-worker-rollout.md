# Grant Browser Worker: separate service, zero live-session changes

## Intent
Stage an additional **independent Edge process**, not a replacement for existing Ubuntu console-mcp browser sessions. Existing CDP ports **9223** (background) and **9224** (visible), their user data directories, and all running application flows are protected. New worker: **9230**, `console-mcp-grants-browser.service`, dedicated UID `console-mcp-grants`, profile `/var/lib/console-mcp-grants-browser/profile`.

## Rules
- Never copy cookies, localStorage, credentials or browser profiles from the legacy users.
- Never reuse a live CDP endpoint or change existing service units and environment files.
- A successful CDP handshake on port 9230 establishes only process independence, **not** readiness for protected websites or job/grant form submission.
- The new browser opens only `about:blank` and does not receive login credentials.
- The service is configured **without** `--no-sandbox`; if Chromium cannot start under the systemd security restrictions, stop and diagnose rather than turn the production sandbox off.
- Chrome DevTools Protocol is not authenticated; keep 9230 bound to loopback, not exposed by a tunnel or proxy. Local machine users/processes able to reach 9230 must be treated as privileged.
- Neither existing browser runtime nor the Console MCP server is restarted to install this worker.

## Preflight and controlled deployment
From the repository root:

```bash
bash ops/ubuntu/script/install-grants-browser.sh --check
sudo bash ops/ubuntu/script/install-grants-browser.sh --install
bash ops/ubuntu/script/install-grants-browser.sh --status
```

Install is **opt-in** and root-only, with no prompt in the script. It rejects an existing unit, a busy port 9230, unhealthy legacy CDP 9223/9224, and a failed systemd unit verification. Installation creates only its own service user, state path, and unit. After startup it checks 9223/9224 retain their original CDP browser-instance IDs. On a failure after unit installation, rollback stops/disables/removes only the new service. State is retained for inspection. No restart or cleanup of existing services.

## Acceptance gates
1. Both legacy endpoints respond before/during/after testing, and their browser-instance IDs match.
2. Port 9230 responds with a **third, distinct** CDP browser-instance ID and a fresh default profile under the grants state root.
3. User/UID, process tree and profile directory belong to `console-mcp-grants`. No legacy profile is open by the new process.
4. Stopping **only** `console-mcp-grants-browser.service` closes 9230 without affecting 9223/9224. Restarting only this new unit may create a new 9230 instance; old instance stability is mandatory.
5. A separate authorization, per-worker target binding, job lease, and form-submission safeguards are required **before** attaching any grant automation. There is currently no Console MCP write routing to 9230.

## Verified acceptance on 2026-10-20

The installed `console-mcp-grants-browser.service` is ACTIVE under `console-mcp-grants`; reported main PID `1915092` at acceptance. CDP ports 9223, 9224, and 9230 simultaneously returned distinct stable browser-instance IDs. `tool/grants-worker-dom-acceptance.ps1` returned `GRANTS_READONLY_DOM_PARALLEL_PASS` with one DOM inspection on the isolated blank grants target and two read-only browser-level checks on the legacy workers. `tool/grants-worker-public-smoke.ps1` created a fresh tab on 9230, navigated only to public `https://www.grants.gov/`, verified allowed origin and interactive DOM with a title, closed only its own tab, and preserved the original `about:blank` page and all three CDP instances. These probes do not prove authenticated grants form submission or production worker routing.

## Grants semantic worker integration staged on 2026-10-20

The source code now supports explicit `browserSession: grants` on the Console MCP Web-domain bridge. The grants path is **pinned** to loopback Web Worker `127.0.0.1:8797` and the browser to `127.0.0.1:9230`, with no implicit fallback to existing isolated/visible sessions. The Console gate and the dedicated Browser Worker independently require host verification: active `console-mcp-grants-browser.service` under `console-mcp-grants`, stable Edge main PID, exact Edge profile and debug port, target ID, browser instance, and humanityai.ai/submittable.com HTTPS allowlist. Grants operations use their own instance lease and postcondition check. The Browser Worker loads this grants-specific verifier **only** when `BROWSER_MCP_GRANTS_WORKER=true`; legacy worker restarts do not import this module.

`ops/ubuntu/systemd/console-mcp-grants-web-worker.service` is opt-in and uses the existing privileged systemd environment to obtain the worker bearer token, without printing it. The semantic Web Worker runs under the existing \`console-mcp\` service account (for restricted read-only access to shared Browser MCP implementation code), with its own state directory \`/var/lib/browser-mcp-grants\`; the Edge process and browser profile remain under the independent \`console-mcp-grants\` account. No cookie or profile files are shared. It enforces all existing Browser MCP approval and receipt checks on fill/upload/submit and a dedicated writable state root. Service start does not restart Console MCP or legacy browser workers.

To install **only** the new semantic worker, after peer review of the source:
```bash
sudo bash /home/alex/smartresponse/mcp/console-mcp/ops/ubuntu/script/install-grants-web-worker.sh --install
```
The guarded installer requires root and must verify source build, loopback browser instance, process identity and port availability. It stops and removes only its own new unit if startup checks fail. On success it reports `GRANTS_WEB_WORKER_ACTIVE`. Then, in a separately coordinated maintenance step, restart the Console MCP runtime to expose the new `browserSession: grants` input schema. **Do not restart Console MCP while a legacy form submission is in flight.** Check tool/schema refresh and approved `read_.web.form.inspect` before enabling form writes. Under no circumstances treat read-only CDP readiness, a local prepared answer packet, or installed systemd unit as evidence that an external application was submitted.

Acceptance: `tool/grants-build-regression.ps1` PASSED: TypeScript compilation, web-domain bridge, legacy visibility/routing, and `GRANTS_PINNED_BRIDGE_PASS`. `tool/grants-routing-preflight.ps1` PASSED typecheck/syntax/allowlist but reported `GRANTS_SOURCE_POLICY_PASS_HOST_PROOF_REQUIRED` because protected MCP script runners do not expose the Edge process via `/proc`; **the real host root installer must independently pass full PID/UID/proc verification**. No root semantic-worker install or live Console MCP restart has occurred as part of this source patch.

## Next integration
Introduce explicit `workerId` routing as a separately reviewed change. Do not overload the shared active-target pointer or weaken the visible-session gate. Refuse execution when a targetId does not belong to the requested worker; one lease per browser instance and one submission idempotency key per grant application. Run parallel DOM **read** regression first, then guarded form dry-run, then human-reviewed live submission. This does not require removing visible Edge at any step.

## Existing smoke script
`tool/grant-worker-isolation-smoke.ps1` is disposable and uses `--no-sandbox` **only for an isolated about:blank smoke** under a restricted MCP script runner. It must never be used to handle external or authenticated websites.
