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
    if set(request) - {'version', 'requestId', 'operation', 'targetId', 'windowId'}:
        raise ValueError('Unknown fields')
    state = status()
    if op == 'status':
        return state
    if op in ('window-inventory', 'window-inspect', 'window-inspect-focus', 'window-activate', 'window-focus-app-test'):
        if not state['ok']:
            return {'ok': False, 'status': 'DESKTOP_SESSION_UNAVAILABLE'}
        window_id = request.get('windowId')
        if op in ('window-inspect', 'window-activate'):
            if not isinstance(window_id, str) or not re.fullmatch(r'0x[0-9a-fA-F]{1,16}', window_id):
                raise ValueError('Invalid window ID')
        elif window_id is not None:
            raise ValueError('Unexpected window ID')
        env = {**os.environ, 'CONSOLE_MCP_DESKTOP_LOCAL': '1', 'CONSOLE_MCP_INTERACTIVE_USER': 'alex'}
        cmd = ['/usr/bin/python3', str(Path(__file__).with_name('window-ops.py')), op]
        if window_id is not None:
            cmd.append(window_id)
        return json.loads(subprocess.check_output(cmd, env=env, text=True, timeout=12))
    if op not in ('verify', 'verify-background', 'focus') or not re.fullmatch(r'[A-Fa-f0-9]{32}', request.get('targetId', '')):
        raise ValueError('Unsupported command')
    # Native verification runs with the user's Xauthority, never the service's.
    env = {**os.environ, 'CONSOLE_MCP_DESKTOP_LOCAL': '1', 'CONSOLE_MCP_INTERACTIVE_USER': 'alex'}
    cli = 'desktop-focus-cli.js' if op == 'focus' else 'desktop-verify-cli.js'
    mode = [] if op == 'focus' else ['background' if op == 'verify-background' else 'interactive']
    return json.loads(subprocess.check_output(['/usr/bin/node', str(ROOT / 'dist/cli' / cli), request['targetId'], *mode], env=env, text=True, timeout=12))

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
                    except (ValueError, OSError, RuntimeError, subprocess.SubprocessError) as exc:
                        # Preserve fail-closed behavior; expose only an allowlisted diagnostic class.
                        cause = ('CHILD_TIMEOUT' if isinstance(exc, subprocess.TimeoutExpired) else
                                 'CHILD_EXIT_NONZERO' if isinstance(exc, subprocess.CalledProcessError) else
                                 'INVALID_INPUT' if isinstance(exc, ValueError) else
                                 'IPC_OR_RUNTIME_ERROR')
                        response = {'ok': False, 'status': 'DESKTOP_SESSION_UNAVAILABLE', 'reason': cause,
                                    'visibility_verified': False, 'user_interaction_ready': False}
                    response['requestId'] = request.get('requestId') if isinstance(request, dict) else None
                    try:
                        client.sendall((json.dumps(response) + '\n').encode())
                    except OSError:
                        pass
        finally:
            path.unlink(missing_ok=True)

if __name__ == '__main__':
    main()
