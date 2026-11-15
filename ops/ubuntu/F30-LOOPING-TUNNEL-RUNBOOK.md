# F30 Looping Unix Tunnel — guarded release handoff

Status: REVIEW CANDIDATE ONLY. Not activated. Base commit: `2fe30b3ca7d541c4d943b743332c0fa64192aa71`.

## Scope and invariants

- ChatGPT Connector: **No Authentication**. Do not enable ChatGPT OAuth.
- Tunnel Runtime: separate Runtime API key at `/home/alex/.config/looping-mcp/runtime-api-key`; owned by alex, mode 0600. Never copy a key into this repository.
- Existing tunnel: `tunnel_6af9436666348191b1757a69939e3fc9`. Separate profile `looping-ubuntu-gold`.
- Main OAuth TCP `:3333` preserved; existing Network Unix listener unchanged.
- New Looping-only upstream: `/run/console-mcp-looping/looping.sock`; HTTP logical route `http://localhost/mcp/looping`.
- Verified local group `smartresponse` GID 1001: alex and console-mcp both members.
- Do not reduce existing ChatGPT/Codex/Runner projections as part of F30.

## Required release gates

1. Confirm a signed, reviewed descendant commit and clean release checkout. F30 review worktree is NOT a release.
2. Compile with `npm ci --ignore-scripts` and `npm run build`.
3. Run `pwsh -NoProfile -File tool/f30-run-looping-socket-regression.ps1` in F30 candidate.
4. Ensure existing Network Tunnel and production listener baseline are healthy.
5. For rollout, install the reviewed tmpfiles config `ops/ubuntu/systemd/console-mcp-looping-tmpfiles.conf` into the system tmpfiles location, and reviewed systemd drop-in `ops/ubuntu/systemd/console-mcp.service.d/65-looping-tunnel.conf` into the service drop-in directory. Applying either is privileged deployment, **not** part of staging.
6. Apply systemd/tmpfiles only through authorized release administration, and verify group/mode/owner of parent directory and socket.
7. Use existing Release Broker transaction prepare → validate → separately authorized activate; require POST gates and rollback checkpoint.
8. Confirm `/run/console-mcp-looping/looping.sock` exists, socket mode 0660, group 1001, parent 0710, and 26 tools plus safe tools/call over socket.

## Tunnel Client connection (ONLY after release and socket verification)

Do not use `--admin-profile default`; it expects `OPENAI_ADMIN_KEY`. Reuse existing tunnel ID and runtime-only credential. The installed CLI advertises `--tunnel-id` to attach without admin CRUD. On Ubuntu Gold, as `alex` (no sudo):

```bash
~/.local/bin/tunnel-client runtimes connect \
  --alias looping-ubuntu-gold \
  --name looping-ubuntu-gold \
  --tunnel-id tunnel_6af9436666348191b1757a69939e3fc9 \
  --profile looping-ubuntu-gold \
  --profile-dir /home/alex/.config/tunnel-client \
  --mcp-server-url 'channel=main,url=http://localhost/mcp/looping,unix-socket=/run/console-mcp-looping/looping.sock' \
  --runtime-api-key 'file:/home/alex/.config/looping-mcp/runtime-api-key' \
  --json
```

**Important:** An existing local profile is present. Inspect and back it up (without revealing keys) before any `connect` call that could rewrite it; fail closed if CLI treats reuse as destructive. Do not run this command until the release gate and socket preflight pass.

Then inspect `runtimes status looping-ubuntu-gold --json` for `process_running=true`, `healthy=true`, `ready=true` and verify ChatGPT tools/list = 26, actual tools/call, and No Authentication selection. No success claim before this.

## Out of scope

- Rotating credentials, changing permissions on OpenAI account, creating a new tunnel, enabling OAuth in ChatGPT.
- Removing tools from main MCP projections.
- Touching Network Tunnel.
- Installing optional Codex tunnel plugin.
