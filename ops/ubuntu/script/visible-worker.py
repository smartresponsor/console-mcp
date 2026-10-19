#!/usr/bin/python3
"""Restart only the attachment worker when the browser instance changes/disconnects."""
import json
import os
import signal
import subprocess
import time
import urllib.request
running = True
signal.signal(signal.SIGTERM, lambda *_: globals().update(running=False))
child = None
instance = None
try:
    while running:
        try:
            # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected -- Fixed loopback CDP endpoint; no user-controlled URL or remote transport.
            with urllib.request.urlopen('http://127.0.0.1:9224/json/version', timeout=2) as response:
                current = json.load(response)['webSocketDebuggerUrl']
        except (OSError, ValueError, KeyError):
            current = None
        if current != instance or (child and child.poll() is not None):
            if child and child.poll() is None:
                child.terminate()
                child.wait(timeout=10)
            child = None
            instance = current
        if current and child is None:
            if not os.environ.get('BROWSER_MCP_BROWSER_WORKER_TOKEN'):
                raise RuntimeError('Worker authentication required')
            env = {**os.environ, 'BROWSER_MCP_WORKER_PORT': '8793', 'BROWSER_MCP_HEADLESS': 'false',
                   'BROWSER_MCP_EXTERNAL_VISIBLE_BROWSER': 'true', 'BROWSER_MCP_REMOTE_DEBUGGING_PORT': '9224',
                   'BROWSER_MCP_USER_DATA_DIR': '/home/alex/.config/console-mcp-edge-visible',
                   'BROWSER_MCP_ENABLE_SUBMIT': 'false', 'PORT': '8793'}
            child = subprocess.Popen(['/usr/bin/node', '/home/alex/smartresponse/mcp/looping/browsing/playwright-worker/src/worker.js'], env=env)
        time.sleep(2)
finally:
    if child and child.poll() is None:
        child.terminate()
        child.wait(timeout=10)
