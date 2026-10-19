#!/usr/bin/python3
"""Exercise the live bounded IPC protocol without browser or form mutation."""
import json
import socket
import uuid

def request(fields):
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(3)
        client.connect('/run/console-mcp-desktop/agent.sock')
        client.sendall((json.dumps({'version': 1, 'requestId': str(uuid.uuid4()), **fields})+'\n').encode())
        return json.loads(client.recv(65536))
status = request({'operation':'status'})
assert isinstance(status['session_id'],str) and status['session_id']
assert status['visibility_verified'] is False and status['user_interaction_ready'] is False
for fields in [{'operation':'exec','command':'id'}, {'operation':'verify','targetId':'http://127.0.0.1:9223'}, {'operation':'status','path':'/etc/shadow'}, {'operation':'verify','targetId':'A'*32,'port':9223}]:
    result = request(fields)
    assert result['ok'] is False and result['visibility_verified'] is False, result
print(json.dumps({'ipcEnvelopeValidation':'PASS','guiSession':status['session_id'],'eligibility':status['ok'],'diagnosticsNeverClaimVisibility':True}))
