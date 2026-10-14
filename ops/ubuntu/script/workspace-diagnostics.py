#!/usr/bin/env python3
"""Read-only, bounded Ubuntu Console MCP workspace diagnostics (no shell)."""
import argparse
import json
import os
from pathlib import Path
import pwd
import re
import subprocess

ROOT = Path('/home/alex/smartresponse')
REPOS = [ROOT / 'mcp/console-mcp', ROOT / 'mcp/looping/browsing']
KEYS = ['User', 'Group', 'ProtectHome', 'ProtectSystem', 'ReadOnlyPaths',
        'ReadWritePaths', 'BindPaths', 'PrivateTmp', 'StateDirectory',
        'FragmentPath', 'DropInPaths', 'MainPID']


def command(args):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=15,
                                check=False, env={**os.environ, 'LC_ALL': 'C'})
        return {'ok': result.returncode == 0, 'exitCode': result.returncode,
                'stdout': result.stdout[:30000], 'stderr': result.stderr[:30000]}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {'ok': False, 'exitCode': None, 'stdout': '', 'stderr': str(error)}


def mount_for(mountinfo, target):
    target = str(target)
    matches = []
    for line in mountinfo.splitlines():
        fields = line.split()
        if len(fields) < 7 or '-' not in fields:
            continue
        decode = lambda value: re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), value)
        mount = decode(fields[4])
        if target == mount or target.startswith(mount.rstrip('/') + '/'):
            separator = fields.index('-')
            matches.append({'target': mount, 'options': fields[5].split(','),
                            'fstype': fields[separator + 1],
                            'source': decode(fields[separator + 2])})
    return max(matches, key=lambda item: len(item['target'])) if matches else None


def classify_mount(host, service):
    if not host or not service:
        return 'WORKSPACE_DIAGNOSTICS_INCOMPLETE'
    if 'ro' in service['options']:
        return 'WORKSPACE_MOUNT_CONFLICT' if 'rw' in host['options'] else 'WORKSPACE_READ_ONLY'
    return 'WORKSPACE_READY'



def acl_can_write(acl, owner_uid, owner_gid, uid, groups):
    if uid is None:
        return None
    entries = {}
    for line in acl.splitlines():
        fields = line.split('#', 1)[0].strip().split(':')
        if len(fields) == 3 and fields[0] != 'default':
            entries[(fields[0], fields[1])] = set(fields[2]) & set('rwx')
    if ('user', '') not in entries:
        return None
    mask = entries.get(('mask', ''), set('rwx'))
    if uid == owner_uid:
        rights = entries[('user', '')]
    elif ('user', str(uid)) in entries:
        rights = entries[('user', str(uid))] & mask
    else:
        matches = [value for (kind, qualifier), value in entries.items()
                   if kind == 'group' and (owner_gid if qualifier == '' else int(qualifier)) in groups]
        rights = (set().union(*matches) & mask) if matches else entries.get(('other', ''), set())
    return set('wx') <= rights


def git_classification(result):
    if result['ok']:
        return 'WORKSPACE_READY'
    if 'detected dubious ownership' in result['stderr']:
        return 'GIT_OWNERSHIP_UNSAFE'
    return 'GIT_STATUS_UNAVAILABLE'


def diagnose(pid):
    issues = []
    errors = []
    systemd = command(['systemctl', 'show', 'console-mcp.service', *['-p' + key for key in KEYS]])
    properties = dict(line.split('=', 1) for line in systemd['stdout'].splitlines() if '=' in line)
    pid = pid or int(properties.get('MainPID', '0'))
    identity = {}
    host_mounts = service_mounts = ''
    try:
        host_mounts = Path('/proc/self/mountinfo').read_text()
        service_mounts = Path(f'/proc/{pid}/mountinfo').read_text()
        status = Path(f'/proc/{pid}/status').read_text()
        for key in ['Uid', 'Gid', 'Groups']:
            match = re.search(r'^' + key + r':\s*(.*)$', status, re.M)
            identity[key] = [int(value) for value in match[1].split()] if match else []
    except (OSError, ValueError) as error:
        issues.append('WORKSPACE_DIAGNOSTICS_INCOMPLETE')
        errors.append(str(error))
    uids = identity.get('Uid', [])
    uid = uids[1] if len(uids) > 1 else None
    try:
        account = pwd.getpwuid(uid).pw_name if uid is not None else None
    except KeyError:
        account = None
    paths = []
    for target in [ROOT, ROOT / 'mcp', *REPOS]:
        item = {'path': str(target)}
        try:
            st = target.stat()
            item.update(ownerUid=st.st_uid, ownerGid=st.st_gid, mode=oct(st.st_mode & 0o7777))
            acl = command(['getfacl', '-ncp', str(target)])
            item['acl'] = acl
            item['unixWriteAllowed'] = acl_can_write(acl['stdout'], st.st_uid, st.st_gid, uid, set(identity.get('Groups', []) + identity.get('Gid', []))) if acl['ok'] else None
        except OSError as error:
            item['error'] = str(error)
            issues.append('WORKSPACE_PERMISSION_DENIED' if isinstance(error, PermissionError) else 'WORKSPACE_DIAGNOSTICS_INCOMPLETE')
            errors.append(str(error))
        item['hostMount'] = mount_for(host_mounts, target)
        item['serviceMount'] = mount_for(service_mounts, target)
        item['status'] = classify_mount(item['hostMount'], item['serviceMount'])
        if item['status'] == 'WORKSPACE_READY':
            if item.get('unixWriteAllowed') is False:
                item['status'] = 'WORKSPACE_PERMISSION_DENIED'
            elif item.get('unixWriteAllowed') is None:
                item['status'] = 'WORKSPACE_DIAGNOSTICS_INCOMPLETE'
        item['writableVerified'] = False
        paths.append(item)
    git = []
    for repo in REPOS:
        args = ['git', '--no-optional-locks', '-C', str(repo), 'status', '--porcelain=v1', '-b']
        if uid != os.geteuid():
            if account is None:
                result = {'ok': False, 'exitCode': None, 'stdout': '', 'stderr': 'Execution identity unavailable'}
            else:
                result = command(['sudo', '-n', '-u', account, '--', *args])
        else:
            result = command(args)
        git.append({'path': str(repo), 'executionUid': uid,
                    'status': git_classification(result), **result})
    for item in paths:
        if item['status'] != 'WORKSPACE_READY':
            issues.append(item['status'])
    for item in git:
        if not item['ok']:
            issues.append(item['status'])
    if not systemd['ok']:
        issues.append('WORKSPACE_DIAGNOSTICS_INCOMPLETE')
    # A read-only diagnostic never claims that successful writes were verified.
    return {'ok': not issues, 'canonicalWorkspace': str(ROOT), 'pid': pid,
            'executionIdentity': identity, 'paths': paths, 'git': git,
            'systemd': properties, 'systemdQuery': systemd,
            'outsideMounts': [mount_for(service_mounts, p) for p in ['/home/alex', '/etc', '/var/lib/console-mcp']],
            'issues': list(dict.fromkeys(issues)), 'errors': errors, 'writesPerformed': False,
            'status': issues[0] if issues else 'WORKSPACE_READY',
            'correlationReference': None, 'transcriptReference': None}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pid', type=int, default=0)
    args = parser.parse_args()
    result = diagnose(args.pid)
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result['ok'] else 1)
