#!/usr/bin/env python3
"""Prepare an immutable release; never change registry, units, sessions, or services."""
import sys
if not sys.flags.isolated:
    raise SystemExit('Use /usr/bin/python3 -I to exclude repository-local Python imports')
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import pwd
import runpy
import stat
import subprocess
import tarfile
import uuid


def git(source, *args):
    command = ['/usr/bin/git', '-c', 'core.fsmonitor=false', '-c', f'safe.directory={source}', '-C', str(source), *args]
    if os.geteuid() == 0:
        owner = pwd.getpwuid(source.stat().st_uid)
        if owner.pw_uid == 0:
            owner = pwd.getpwnam('alex')
        command = ['/usr/sbin/runuser', '-u', owner.pw_name, '--', '/usr/bin/setpriv', '--no-new-privs',
                   '/usr/bin/env', '-i', 'HOME=' + owner.pw_dir, 'PATH=/usr/bin:/bin', *command]
    return subprocess.check_output(command)


def fingerprint(dist):
    digest = hashlib.sha256()
    for name in sorted(p.relative_to(dist).as_posix() for p in dist.rglob('*') if p.is_file()):
        digest.update(name.encode()); digest.update(b'\0')
        digest.update((dist / name).read_bytes()); digest.update(b'\0')
    return digest.hexdigest()[:16]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--sha', required=True)
    parser.add_argument('--seal', action='store_true', help='Requires an explicitly authorized root session')
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    if len(args.sha) != 40 or any(c not in '0123456789abcdef' for c in args.sha):
        raise RuntimeError('Full SHA required')
    if git(source, 'rev-parse', 'HEAD').decode().strip() != args.sha or git(source, 'status', '--porcelain', '--untracked-files=no').strip():
        raise RuntimeError('Source must be clean at the exact SHA')
    git(source, 'merge-base', '--is-ancestor', args.sha, 'origin/master')
    base = Path('/opt/console-mcp-deploy')
    final = base / 'releases' / args.sha
    if not args.seal:
        print(json.dumps(dict(source=str(source), sourceCommit=args.sha, destination=str(final),
                              rootRequiredForSeal=True, registryChanged=False, serviceRestarted=False)))
        return
    if os.geteuid() != 0:
        raise RuntimeError('Authorized administrative root session required; no escalation attempted')
    if final.exists():
        raise RuntimeError('Existing release preserved; verify it separately, never overwrite')
    for parent in (base, base / 'releases'):
        if parent.is_symlink() or parent.stat().st_uid != 0 or parent.stat().st_mode & 0o022:
            raise RuntimeError('Untrusted deploy root')
    alex = pwd.getpwnam('alex')
    stage = base / ('.staging-' + uuid.uuid4().hex)
    stage.mkdir(mode=0o700)
    # Use committed bytes, not mutable source/dependency files owned by the running service.
    wanted = ['src', 'tool', 'policy', 'config', 'ops', 'bin', 'prompt', 'package.json', 'package-lock.json', 'tsconfig.json']
    paths = [name for name in wanted if git(source, 'ls-files', '--', name).strip()]
    archive = git(source, 'archive', '--format=tar', args.sha, '--', *paths)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        for member in tar.getmembers():
            if member.issym() or member.islnk() or not (member.isfile() or member.isdir()):
                raise RuntimeError('Unexpected tracked link/special file; staging preserved for review')
        tar.extractall(stage, filter='data')
    package = json.loads((stage / 'package.json').read_text())
    if package['scripts']['build'] != 'tsc -p tsconfig.json':
        raise RuntimeError('Build command changed; explicit review required')
    lock = json.loads((stage / 'package-lock.json').read_text())
    for name, item in lock['packages'].items():
        if name and (item.get('link') or not item.get('integrity') or not item.get('resolved', '').startswith('https://registry.npmjs.org/')):
            raise RuntimeError('Unpinned dependency; staging preserved')
    for item in [stage, *stage.rglob('*')]:
        os.chown(item, alex.pw_uid, alex.pw_gid, follow_symlinks=False)
    env = ['HOME=' + alex.pw_dir, 'USER=alex', 'PATH=/usr/bin:/bin']
    for command in (['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
                    ['npm', 'run', 'build'], ['npm', 'prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']):
        subprocess.run(['/usr/sbin/runuser', '-u', 'alex', '--', '/usr/bin/setpriv', '--no-new-privs', '/usr/bin/env', '-i', *env, *command], cwd=stage, check=True, timeout=600)
    files = {}
    for item in [stage, *stage.rglob('*')]:
        info = item.lstat()
        if item.is_symlink():
            if not item.resolve().is_relative_to(stage.resolve()):
                raise RuntimeError('Escaping dependency link; staging preserved')
            files[item.relative_to(stage).as_posix()] = 'link:' + os.readlink(item)
        elif item.is_file():
            files[item.relative_to(stage).as_posix()] = hashlib.sha256(item.read_bytes()).hexdigest()
        elif not item.is_dir():
            raise RuntimeError('Special release member; staging preserved')
        os.chown(item, 0, 0, follow_symlinks=False)
        if not item.is_symlink():
            item.chmod(0o755 if item.is_dir() or info.st_mode & stat.S_IXUSR else 0o644)
    manifest = dict(sourceCommit=args.sha, buildFingerprint=fingerprint(stage / 'dist'), files=files,
                    lockfileSha256=hashlib.sha256((stage / 'package-lock.json').read_bytes()).hexdigest())
    (stage / 'release.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (stage / 'release.json').chmod(0o644)
    verifier = runpy.run_path(str(base / 'deploy.py'), run_name='seal_verifier_only')['verify']
    verifier(stage)
    stage.rename(final)
    print(json.dumps(dict(sourceCommit=args.sha, release=str(final), buildFingerprint=manifest['buildFingerprint'],
                          verified=True, registryChanged=False, serviceRestarted=False)))


if __name__ == '__main__':
    main()
