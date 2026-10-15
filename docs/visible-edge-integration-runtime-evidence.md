# Visible Edge integration evidence — 2026-10-15

Status at 20:00–20:05 UTC: **DEPLOYED IN PART; ACCEPTANCE BLOCKED**, not GREEN. Production user/system services, authenticated IPC, browserSession routing/schema and exact-ID binding are live. The final exact-target capture/native-focus artifact is built and signed but awaits desktop unlock and interactive polkit authentication. No successful live MCP screenshot capture is claimed.

Repository: `/home/alex/smartresponse/mcp/console-mcp`, branch `fix/ubuntu-workspace-writes`. Signed commits: `1620dff6756bd58a0fe45307d7845b445eb31b4c` (runtime), `0cb7b81840b7536d8c5ae474be553b07e3a6dcc8` (exact capture/native focus); both verified `G` by Git. Unrelated working-tree edits, including concurrent policy/database work, were excluded. Staging was built from the original tracked checkout plus only the reviewed runtime files, rather than the dirty working tree.

## Installed architecture and actual identity

Ubuntu 24.04 GNOME, host `alex-HP-Spectre-x360-Convertible-15-df1xxx`. Local logind session `1`, user alex, UID 1000, seat0/tty2, type X11, DISPLAY `:0`, XAUTHORITY `/run/user/1000/gdm/Xauthority`, XDG_RUNTIME_DIR `/run/user/1000`. These values came from GNOME's actual user-manager environment and were correlated with the logind session. `graphical-session.target` is active; user lingering is disabled.

| Runtime/unit | Owner | PID | Port |
| --- | --- | --- | --- |
| Console MCP `console-mcp.service` | console-mcp (UID 993) | 17378 | loopback 3333/3334 |
| Isolated Edge (`console-mcp-browser.service` monitor 13423) | console-mcp | 13443 | loopback 9223 |
| Isolated `browser-mcp-worker.service` | console-mcp | 13424 | loopback 8791 |
| Visible Edge, profile `~/.config/console-mcp-edge-visible` | alex | 11571 | loopback 9224 |
| User `console-mcp-visible-edge.service` monitor | alex | 16115 | — |
| User `console-mcp-desktop-agent.service` | alex | 13404 | dedicated Unix socket |
| System `console-mcp-visible-worker.service` supervisor / Node worker | console-mcp-visible | 14297 / 14298 | loopback 8793 |

Both user units and the visible system worker are installed/enabled. The agent and Edge monitor are PartOf graphical-session.target. Lock leaves them running; authorization fails closed. The worker has its own UID/group, only its worker token, loopback-only network policy and no user-runtime access. Console receives only the dedicated desktop IPC supplemental group. No X11 cookie was copied, no access to `/run/user/1000` was granted, and no Xvfb is used for visible Edge.

The desktop peer-authentication test rejected root using kernel SO_PEERCRED. Live IPC tests rejected arbitrary commands, unknown fields, paths, URLs and alternate ports. A privileged deployment check verified that the worker cannot read Console's credential file or traverse the user runtime directory.

## Live schema and browser evidence

Authenticated MCP `tools/list` on the real localhost bearer endpoint 3334 returned `browserSession` with enum `["isolated", "visible"]` on:

- `read_.web.browser.targets`
- `write.web.browser.bind`
- `read_.web.page.capture`

Visible discovery returned endpoint `http://127.0.0.1:9224`, four page targets including the two restored GC AI application tabs. Authenticated inventories from worker 8793 matched all ten CDP targets on 9224; worker 8791 matched all three targets on 9223. Unauthorized inventory POSTs returned HTTP 401; authorized POSTs returned HTTP 200. Visible routing is pinned to 8793; attempts to configure it to the isolated worker fail validation rather than falling back.

At 19:54:47 UTC the live MCP exact-ID bind succeeded for `B6861753661A8FD0A8A9E9B1F2791D4B`, GC AI application page. Evidence joined the actual listening socket to Edge PID 11571, UID 1000, start tick 166728, persistent profile, CDP browser instance `/devtools/browser/95e10d56-c426-439c-be02-dd9802974804`, session 1 and active native window `0x2a00004` (CDP window 2030395618). X11 physical bounds were 132,64 / 3708×2096; native Xft.dpi=192 matched CDP logical bounds 66,32 / 1854×1048. `visibility_verified` and `user_interaction_ready` were true. Binding did not edit or submit the form.

Capture then hit a real input-schema limitation: `MCP error -32602 ... Unrecognized key(s) in object: 'targetId'`. The signed final source adds optional exact `targetId` to capture. It also measures native tab visibility with focus emulation disabled in the verifier's CDP session, because Playwright otherwise makes background tabs report visible. This final artifact has not yet been activated, so its live success is not claimed.

## Acceptance results

| Check | Actual result |
| --- | --- |
| 1. Console health | PASS: authenticated live tools/list and tool calls |
| 2. Isolated 9223/8791 healthy | PASS: matching CDP inventories and authenticated worker response |
| 3. Visible Edge in desktop | PASS: alex process, original profile, real mapped active X11 window |
| 4. Worker 8793 attached to 9224 | PASS: matching target inventory and live bind through worker |
| 5. Desktop Agent GUI/window identity | PASS: authenticated IPC plus PID/profile/window/bounds proof |
| 6. Live browserSession schema | PASS: all three specified tools |
| 7. Discover and uniquely bind visible tab | PASS: explicit target ID, live MCP bind |
| 8. Capture and inspect without submission | BLOCKED: final capture artifact needs authentication; screenshot not yet inspected |
| 9. Locked desktop fails closed | PASS: actual LockedHint=yes at 20:00:13 UTC; live MCP capture returned WEB_VISIBLE_SESSION_REQUIRED / SESSION_NOT_VISIBLE; false readiness, mutation_attempted=false; Edge/worker/agent stayed alive |
| 10. Profile/tabs survive controlled service restart | PASS for monitor restart: Edge PID, profile, browser instance and tab IDs unchanged; graceful full-browser restart/reconnect still unexercised |
| 11. Repeated activation creates no duplicates | PASS for repeated monitor activation: one matching main Edge PID and one visible Node worker |

Full attended logout/relogin has not been exercised. Its GNOME lifecycle integration is implemented; a monitor restart is not represented as a logout/relogin test. Worker reconnection supervision is implemented but still needs a controlled full-browser restart test.

Final staged validation exited 0: typecheck, build, visible browser policy, Linux diagnostics, Web bridge (including numeric-status normalization, pinned routing and exact capture input), observer safety, agent protocol contract, Python/unit static validation and desktop client regression. Live IPC envelope validation passed. Runtime acceptance reports record unchanged task-file hashes and no submission attempts. No task or scheduler mutations were requested.

## Deployment incident and preservation

The first Console restart unintentionally propagated through the preexisting installed isolated browser `Requires=console-mcp.service`, restarting isolated Edge and its worker. Their persistent profile was preserved, but the isolated target inventory fell from 11 to 3; full isolated tab continuity is not claimed. This was an execution mistake, not a visible-runtime requirement. The installed unit was migrated to Wants and its original saved as `.service.before-visible`. Subsequent authorized Console restart verified both isolated service PIDs unchanged. The installer now performs the dependency migration before restarting Console.

Code deployment used atomic renameat2 directory exchanges and retained original dist in `tmp/visible-runtime-dist-before`. Intermediate backups exist under `tmp/visible-runtime-dist-before-scaling` and `tmp/visible-runtime-dist-before-protocol`. Browser profiles and task/scheduler state were not replaced. No reboot occurred. Administrator actions used Ubuntu's interactive polkit; failed authorization was not bypassed.

## Remaining action and rollback

Unlock the desktop normally and authenticate the pending polkit request for `tmp/deploy-visible-target-capture.sh`. It checks `dist-reviewed.sha256`, atomically installs the final candidate, grants read-only access only to review screenshots, restarts Console, and asserts isolated service PIDs remain unchanged. Then run `tool/visible-runtime-acceptance.ps1`, inspect the screenshot, test graceful browser restart/reconnection and repeat unlocked acceptance. Do not submit an application or modify a form.

The final candidate is `tmp/visible-runtime-20261015`. Final comprehensive reviewed manifest SHA-256: `c6e4f95cc6821c82da3f4cad50c24582f229221213ecb2016870a32a78867b7e`. Private service reports: `/var/lib/console-mcp/run/visible-runtime-acceptance.json` and `visible-runtime-locked.json`. They contain evidence summaries; screenshots/form data remain private runtime artifacts, not Git content.

Rollback and installation details are in [the Visible runtime runbook](../ops/ubuntu/runbook/visible-runtime.md). Disable the two visible user units and the visible system worker, atomically exchange original dist back, then restart only Console. Preserve both browser profiles, task/scheduler state and rollback artifacts. Keep the independent-browser lifetime migration to avoid another isolated restart.
