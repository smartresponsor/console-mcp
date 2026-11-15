# NETMCP — OpenAI Tunnel transport without a second OAuth layer

Status: candidate implementation. **Not deployed**. Keep ChatGPT cutover OFF until live connector tests pass.

## Security boundary

The existing OAuth TCP `/mcp/network` remains OAuth-protected. A second, opt-in
HTTP-over-Unix-socket listener exposes **only** `POST /mcp/network` and only
canonical `read_.network.http.probe`. It does not expose `/mcp`, other
facades, metadata routes or a second registry.

The local tunnel user is `alex` (uid 1000). The Console MCP service user is
`console-mcp` (uid 993). Both belong to the existing `smartresponse` group
(gid 1001). The dedicated directory is 0710 with ownership
`console-mcp:smartresponse`; the socket is 0660 with the same ownership.
No untrusted local process lacking that group can reach the socket.
Do not grant `smartresponse` membership to unrelated users.

The separate `ubuntu-network` tunnel uses a dedicated OpenAI runtime key for
control-plane authentication. The key stays referenced as a private file in the
tunnel-client YAML. No separate user OAuth is required for the Unix transport.
Do not expose the socket via public HTTP, a permissive directory or network share.

## Ubuntu staged activation (admin authorization required)

1. Verify the candidate is deployed via a normal root-broker transaction and
   production has passed its rollback and browser continuity gates.
2. Install the vetted `console-mcp-network-tmpfiles.conf` in
   `/etc/tmpfiles.d/`, root-owned 0644, and apply it using
   `systemd-tmpfiles --create`. Verify owner `console-mcp:smartresponse`
   and permissions 0710 on `/run/console-mcp-network`.
3. Install the vetted service drop-in `60-network-tunnel.conf` in
   `/etc/systemd/system/console-mcp.service.d/`, root-owned 0644.
   Run `systemctl daemon-reload` and `systemd-analyze verify` before restart.
4. Back up `/etc/console-mcp/console-mcp.env` and add exactly:
   `CONSOLE_MCP_NETWORK_TUNNEL_SOCKET=/run/console-mcp-network/network.sock`
   and `CONSOLE_MCP_NETWORK_TUNNEL_GID=1001`. Keep
   `CONSOLE_MCP_NETWORK_FACADE_ENABLED=1`; leave cutover OFF.
5. Restart only `console-mcp.service` in a reviewed safe window. Verify
   `/run/console-mcp-network/network.sock` mode 0660,
   `systemctl is-active`, PID, build fingerprint and browser continuity.
   Smoke the Unix socket without an Authorization header and verify only
   `read_.network.http.probe` is listed. Verify TCP access still rejects
   missing OAuth with 401.
6. Back up `/home/alex/.config/tunnel-client/ubuntu-network.yaml`
   (contains only key references; never copy a raw API key into logs).
   Configure `mcp.server_urls` main channel with Unix socket mapping:
   `url: "http://localhost/mcp/network"` and
   `unix_socket: "/run/console-mcp-network/network.sock"`.
   Validate the exact YAML schema with installed tunnel-client
   `doctor --profile ubuntu-network --explain`. Preserve the existing
   `control_plane.tunnel_id` and private `api_key` file reference.
7. Restart **only** `ubuntu-network` using supported managed
   `runtimes stop/connect`, then verify `/healthz=200`,
   `/readyz=200`, first successful control-plane poll, and a connector
   `tools/list` containing exactly one expected network tool.
8. Only after ChatGPT connector visibility and call checks, independently
   enable `CONSOLE_MCP_NETWORK_FACADE_CUTOVER=1` and revalidate both
   endpoint inventories. Codex, runner and Lightpanda must not change.

### Rollback

Keep both environment and service-unit backups and the broker rollback
checkpoint. To disable the local tunnel, stop only `ubuntu-network`, remove
the two `CONSOLE_MCP_NETWORK_TUNNEL_*` env lines, restart Console MCP in an
approved safe window, and verify previous main MCP visibility. Do not remove
the ACL directory while a socket listener is active. Never remove OAuth from
public TCP routes.
