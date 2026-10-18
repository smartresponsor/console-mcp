#!/usr/bin/python3
"""Monitor/reuse the exact persistent desktop browser; never kill an adopted process."""
import fcntl
import json
import os
from pathlib import Path
import signal
import shlex
import subprocess
import time
import urllib.request
from importlib.machinery import SourceFileLoader
session = SourceFileLoader('visible_session', str(Path(__file__).with_name('visible-session.py'))).load_module().session
profile = str(Path.home() / '.config/console-mcp-edge-visible')
lock = open('/run/user/1000/console-mcp-visible-edge.lock', 'w')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
running = True
signal.signal(signal.SIGTERM, lambda *_: globals().update(running=False))

def owner():
    matches = []
    for p in Path('/proc').glob('[0-9]*'):
        try:
            raw = (p / 'cmdline').read_bytes().rstrip(b'\0')
            args = [a.encode() for a in shlex.split(raw.decode())] if b'\0' not in raw else raw.split(b'\0')
            if (b'--remote-debugging-port=9224' in args and
                    ('--user-data-dir=' + profile).encode() in args and
                    not any(a.startswith(b'--type=') for a in args) and
                    p.stat().st_uid == 1000):
                if os.readlink(p / 'exe') != '/opt/microsoft/msedge/msedge':
                    raise RuntimeError('Wrong browser executable')
                matches.append(int(p.name))
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            pass
    if len(matches) > 1:
        raise RuntimeError('Duplicate desktop browsers')
    return matches[0] if matches else None

session()  # Lock does not terminate the runtime; authorization is checked per request.
child = None
while running:
    session()
    pid = owner()
    if not pid:
        try:
            # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected -- Fixed loopback CDP endpoint; no user-controlled URL or remote transport.
            urllib.request.urlopen('http://127.0.0.1:9224/json/version', timeout=1)
        except OSError:
            child = subprocess.Popen(['/usr/bin/microsoft-edge-stable',
                '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9224',
                '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
                '--restore-last-session'])
            time.sleep(3)
            if child.poll() is not None:
                raise RuntimeError('Edge launch did not acquire profile')
        else:
            raise RuntimeError('9224 occupied by an unverified browser')
    time.sleep(2)
# Restart detaches the monitor. Logout stops the exact verified browser gracefully.
if subprocess.run(['systemctl', '--user', 'is-active', '--quiet', 'graphical-session.target']).returncode:
    pid = owner()
    if pid:
        os.kill(pid, signal.SIGTERM)
