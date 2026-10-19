#!/bin/bash
# Authorized deployment only. Does not touch isolated browser/worker, profiles or task state.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Interactive root authorization required' >&2; exit 77; }
root=/home/alex/smartresponse/mcp/console-mcp
candidate="${1:-$root/tmp/visible-runtime-20261015}"
case "$candidate" in "$root"/tmp/visible-runtime-*) ;; *) echo "Unexpected staging path" >&2; exit 1 ;; esac
cd "$candidate"
sha256sum --check --quiet reviewed.sha256
[[ ! -e "$root/tmp/visible-runtime-dist-before" ]] || { echo 'Backup exists; review before redeployment' >&2; exit 1; }
getent group console-mcp-desktop >/dev/null || groupadd --system console-mcp-desktop
id console-mcp-visible >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/console-mcp-visible --shell /usr/sbin/nologin console-mcp-visible
install -d -m 0755 /etc/systemd/system/console-mcp.service.d
printf '[Service]\nSupplementaryGroups=console-mcp-desktop\n' > /etc/systemd/system/console-mcp.service.d/60-desktop-ipc.conf
# Worker receives only its shared worker credential, never Console's bearer/OAuth secrets.
python3 - <<'CONFIG'
from pathlib import Path
import os, pwd, grp
entries = dict(line.split('=', 1) for line in Path('/etc/console-mcp/browsing.env').read_text().splitlines() if line and not line.startswith('#') and '=' in line)
token = entries.get('BROWSER_MCP_BROWSER_WORKER_TOKEN', '').strip()
if not token or '\n' in token:
    raise SystemExit('Worker credential missing')
p = Path('/etc/console-mcp/visible-worker.env')
p.write_text('BROWSER_MCP_BROWSER_WORKER_TOKEN=' + token + '\n')
os.chown(p, 0, grp.getgrnam('console-mcp-visible').gr_gid)
os.chmod(p, 0o640)
CONFIG
setfacl -m u:console-mcp-visible:--x /etc/console-mcp
setfacl -m u:console-mcp-visible:--x /home/alex
install -m 0644 "$root/ops/ubuntu/config/console-mcp-desktop.tmpfiles" /etc/tmpfiles.d/console-mcp-desktop.conf
systemd-tmpfiles --create /etc/tmpfiles.d/console-mcp-desktop.conf
install -m 0644 "$root/ops/ubuntu/systemd/console-mcp-visible-worker.service" /etc/systemd/system/
install -d -o alex -g alex -m 0755 /home/alex/.config/systemd/user
install -o alex -g alex -m 0644 "$root"/ops/ubuntu/systemd/user/*.service /home/alex/.config/systemd/user/
# Stage complete build, then atomically exchange directories on this filesystem.
cp -a "$candidate/dist" "$root/tmp/visible-runtime-dist-before"
chmod -R a+rX "$root/tmp/visible-runtime-dist-before"
python3 - "$root/dist" "$root/tmp/visible-runtime-dist-before" <<'PY'
import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
if libc.renameat2(-100, os.fsencode(sys.argv[1]), -100, os.fsencode(sys.argv[2]), 2):
    raise OSError(ctypes.get_errno(), 'Atomic dist exchange failed')
PY
setfacl -m u:console-mcp-visible:r-- "$root/ops/ubuntu/script/visible-worker.py" "$root/ops/ubuntu/script/desktop-agent-client.py"
setfacl -R -m u:console-mcp-visible:r-X /home/alex/smartresponse/mcp/looping/browsing/playwright-worker/src /home/alex/smartresponse/mcp/looping/browsing/playwright-worker/node_modules
install -d -m 0755 /etc/systemd/system/console-mcp-browser.service.d
python3 - <<'INDEPENDENCE'
from pathlib import Path
p = Path('/etc/systemd/system/console-mcp-browser.service')
s = p.read_text()
if 'Requires=console-mcp.service' in s:
    backup = p.with_suffix('.service.before-visible')
    if not backup.exists():
        backup.write_text(s)
    p.write_text(s.replace('Requires=console-mcp.service', 'Wants=console-mcp.service'))
INDEPENDENCE
systemctl daemon-reload
# Share only review images, never worker state or browser profile data.
install -d -o console-mcp-visible -g console-mcp-visible -m 0700 /var/lib/console-mcp-visible /var/lib/console-mcp-visible/var /var/lib/console-mcp-visible/var/browser
setfacl -m u:console-mcp:--x,u:alex:--x /var/lib/console-mcp-visible /var/lib/console-mcp-visible/var
setfacl -m u:console-mcp:r-x,u:alex:r-x,d:u:console-mcp:r-x,d:u:alex:r-x /var/lib/console-mcp-visible/var/browser
systemctl enable --now console-mcp-visible-worker.service
runuser -u alex -- env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user daemon-reload
runuser -u alex -- env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user enable --now console-mcp-visible-edge.service console-mcp-desktop-agent.service
systemctl restart console-mcp.service
systemctl is-active console-mcp.service console-mcp-visible-worker.service console-mcp-browser.service browser-mcp-worker.service
