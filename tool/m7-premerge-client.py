#!/usr/bin/python3
"""Explicit evidence-only request to the installed, authenticated root broker."""
import argparse
import json
import os
import re
import socket
import stat
import struct

SOCKET='/run/console-mcp-release/release-broker.sock'

def payload(action,sha=None,run_id=None,confirmed=False):
    if action=='accept':
        if not isinstance(sha,str) or not re.fullmatch('[0-9a-f]{40}',sha):raise ValueError('RELEASE_FULL_SHA_REQUIRED')
        if confirmed is not True:raise ValueError('RELEASE_EXPLICIT_CONFIRMATION_REQUIRED')
        return dict(version=3,operation='premerge-accept',sha=sha,confirmed=True)
    if action=='status':
        if not isinstance(run_id,str) or not re.fullmatch('[0-9a-f]{32}',run_id):raise ValueError('RELEASE_RUN_ID_INVALID')
        return dict(version=1,operation='status',runId=run_id)
    raise ValueError('RELEASE_PREMERGE_REQUEST_INVALID')

def exchange(request):
    if os.getuid()!=993:raise PermissionError('RELEASE_PREMERGE_CLIENT_UID')
    p=os.lstat(os.path.dirname(SOCKET));st=os.lstat(SOCKET)
    if not stat.S_ISDIR(p.st_mode) or p.st_uid!=0 or p.st_mode&0o022 or not stat.S_ISSOCK(st.st_mode) or st.st_uid!=0 or st.st_mode&0o007:
        raise PermissionError('RELEASE_PREMERGE_SOCKET_POLICY')
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
        s.settimeout(15);s.connect(SOCKET)
        if struct.unpack('3i',s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]!=0:
            raise PermissionError('RELEASE_PREMERGE_SERVER_DENIED')
        s.sendall(json.dumps(request).encode()+b'\n')
        with s.makefile('rb') as stream:raw=stream.readline(65537)
    if len(raw)>65536 or not raw.endswith(b'\n'):raise ValueError('RELEASE_PREMERGE_RESPONSE_LIMIT')
    result=json.loads(raw)
    if type(result) is not dict:raise ValueError('RELEASE_PREMERGE_RESPONSE_INVALID')
    return result

def main():
    p=argparse.ArgumentParser()
    sub=p.add_subparsers(dest='action',required=True)
    accept=sub.add_parser('accept');accept.add_argument('--sha',required=True);accept.add_argument('--confirm',action='store_true')
    status=sub.add_parser('status');status.add_argument('--run-id',required=True)
    args=p.parse_args()
    try:
        result=exchange(payload(args.action,getattr(args,'sha',None),getattr(args,'run_id',None),getattr(args,'confirm',False)))
    except (ValueError,OSError) as error:
        result={'ok':False,'status':str(error) if isinstance(error,ValueError) else 'RELEASE_PREMERGE_CLIENT_FAILURE'}
    print(json.dumps(result,sort_keys=True))
    raise SystemExit(0 if result.get('ok') is True else 1)

if __name__=='__main__':main()
