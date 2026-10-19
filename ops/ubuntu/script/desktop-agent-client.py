#!/usr/bin/python3
"""Bounded IPC; authenticate the user-side server before sending a request."""
import json
import socket
import struct
import sys
request = sys.stdin.buffer.read(4097)
if len(request) > 4096:
    raise SystemExit('Request too large')
with socket.socket(socket.AF_UNIX) as client:
    client.settimeout(15)
    client.connect('/run/console-mcp-desktop/agent.sock')
    _, uid, _ = struct.unpack('3i', client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    if uid != 1000:
        raise SystemExit('Untrusted desktop server')
    client.sendall(request + b'\n')
    data = b''
    while b'\n' not in data:
        chunk = client.recv(4096)
        if not chunk or len(data) + len(chunk) > 65536:
            raise SystemExit('Invalid desktop response')
        data += chunk
    reply = json.loads(data)
    if reply.get('requestId') != json.loads(request).get('requestId'):
        raise SystemExit('Mismatched desktop response')
    print(json.dumps(reply))
