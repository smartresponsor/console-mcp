#!/usr/bin/env python3
"""Read-only desktop session observer; never launches browsers or changes windows."""
import json
import os
import socket
import subprocess
from pathlib import Path

def status():
    sid = os.environ.get("XDG_SESSION_ID")
    user = os.environ.get("USER")
    result = {"ok": False, "status": "DESKTOP_SESSION_UNAVAILABLE",
              "session_id": sid, "user": user,
              "display": os.environ.get("DISPLAY"),
              "wayland_display": os.environ.get("WAYLAND_DISPLAY"),
              "visibility_verified": False, "user_interaction_ready": False}
    if not sid or not user or user == "console-mcp" or os.geteuid() == 0:
        return result
    try:
        output = subprocess.check_output(
            ["loginctl", "show-session", sid, "-p", "Active", "-p", "Remote",
             "-p", "Class", "-p", "Type", "-p", "Name", "-p", "LockedHint"],
            text=True, timeout=2)
        props = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
        eligible = (props.get("Active") == "yes" and props.get("Remote") == "no"
                    and props.get("Class") == "user" and props.get("Name") == user
                    and props.get("LockedHint") == "no"
                    and props.get("Type") in ("x11", "wayland")
                    and bool(result["display"] or result["wayland_display"]))
        result["ok"] = eligible
        result["status"] = "DESKTOP_SESSION_ELIGIBLE" if eligible else "DESKTOP_SESSION_UNAVAILABLE"
        result["session_type"] = props.get("Type")
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    return result

def main():
    runtime = Path(os.environ.get("XDG_RUNTIME_DIR") or "/nonexistent")
    if not runtime.is_absolute() or not runtime.is_dir() or runtime.stat().st_uid != os.geteuid():
        raise SystemExit("Private user runtime directory required")
    path = runtime / "console-mcp-desktop-agent.sock"
    if path.exists():
        raise SystemExit("Socket already exists; refusing to replace")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
        server.bind(str(path))
        os.chmod(path, 0o600)
        server.listen(4)
        server.settimeout(1)
        try:
            while True:
                try:
                    client, _ = server.accept()
                except socket.timeout:
                    continue
                with client:
                    client.settimeout(2)
                    if client.recv(128).strip() == b"status":
                        client.sendall((json.dumps(status()) + "\n").encode())
                    else:
                        client.sendall(b'{"ok":false,"status":"UNSUPPORTED_COMMAND"}\n')
        finally:
            path.unlink(missing_ok=True)

if __name__ == "__main__":
    main()
