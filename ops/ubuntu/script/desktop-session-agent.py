#!/usr/bin/python3
"""Login-bound verifier. Only allowlisted kernel UIDs, bounded fixed operations."""
import fcntl
import grp
import json
import os
from pathlib import Path
import pwd
import re
import signal
import socket
import struct
import subprocess
from importlib.machinery import SourceFileLoader
session = SourceFileLoader('visible_session', str(Path(__file__).with_name('visible-session.py'))).load_module().session
ROOT = Path(__file__).resolve().parents[3]

def status():
    s = session()
    eligible = s.get('Active') == 'yes' and s.get('LockedHint') == 'no'
    return {'ok': eligible, 'status': 'DESKTOP_SESSION_ELIGIBLE' if eligible else 'DESKTOP_SESSION_UNAVAILABLE',
            'session_id': s['Id'], 'user': s['Name'], 'display': os.environ['DISPLAY'],
            'visibility_verified': False, 'user_interaction_ready': False}

def handle(request):
    if not isinstance(request, dict) or request.get('version') != 1 or not re.fullmatch(r'[a-zA-Z0-9-]{1,64}', request.get('requestId', '')):
        raise ValueError('Invalid envelope')
    op = request.get('operation')
    if set(request) - {'version', 'requestId', 'operation', 'targetId'}:
        raise ValueError('Unknown fields')
    state = status()
    if op == 'status':
        return state
    if op not in ('verify', 'verify-background') or not re.fullmatch(r'[A-Fa-f0-9]{32}', request.get('targetId', '')):
        raise ValueError('Unsupported command')
    # Native verification runs with the user's Xauthority, never the service's.
    env = {**os.environ, 'CONSOLE_MCP_DESKTOP_LOCAL': '1', 'CONSOLE_MCP_INTERACTIVE_USER': 'alex'}
    return json.loads(subprocess.check_output(['/usr/bin/node', str(ROOT / 'dist/cli/desktop-verify-cli.js'), request['targetId'], 'background' if op == 'verify-background' else 'interactive'], env=env, text=True, timeout=12))

def main():
    session()
    lock = open('/run/user/1000/console-mcp-desktop-agent.lock', 'w')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    allowed = {1000, pwd.getpwnam('console-mcp').pw_uid, pwd.getpwnam('console-mcp-visible').pw_uid}
    path = Path('/run/console-mcp-desktop/agent.sock')
    path.unlink(missing_ok=True)  # only after acquiring exclusive lock
    signal.signal(signal.SIGTERM, lambda *_: exit(0))
    with socket.socket(socket.AF_UNIX) as server:
        server.bind(str(path))
        os.chmod(path, 0o660)
        server.listen(8)
        try:
            while True:
                client, _ = server.accept()
                with client:
                    client.settimeout(3)
                    _, uid, _ = struct.unpack('3i', client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                    if uid not in allowed:
                        continue
                    request = {}
                    try:
                        data = b''
                        while b'\n' not in data:
                            chunk = client.recv(1024)
                            if not chunk or len(data) + len(chunk) > 4096:
                                raise ValueError('Invalid request')
                            data += chunk
                        request = json.loads(data)
                        response = handle(request)
                    except (ValueError, OSError, RuntimeError, subprocess.SubprocessError):
                        response = {'ok': False, 'status': 'DESKTOP_SESSION_UNAVAILABLE', 'visibility_verified': False, 'user_interaction_ready': False}
                    response['requestId'] = request.get('requestId') if isinstance(request, dict) else None
                    try:
                        client.sendall((json.dumps(response) + '\n').encode())
                    except OSError:
                        pass
        finally:
            path.unlink(missing_ok=True)

if __name__ == '__main__':
    main()
