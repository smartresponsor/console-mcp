"""Read-only release admission for the owner preservation broker. Never installs or starts units."""
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import pwd
import grp

BUNDLE = pathlib.Path('/opt/console-mcp/preservation-audit')
CONFIG = pathlib.Path('/etc/console-mcp/preservation-audit.json')
SOCKET = '/run/console-mcp-preservation/broker.sock'
ROOT = '/home/alex/smartresponse'
LIVE = ROOT + '/mcp/console-mcp'
NAMES = ('preservation_ipc', 'preservation_hardened', 'preservation_activation',
         'preservation_identity', 'preservation_server_v3')
FILES = {'preservation_bundle.py', 'collector_windows.py'} | {n + '.py' for n in NAMES}

def unique(pairs):
    result = {}
    for k, v in pairs:
        if k in result:
            raise ValueError('PRESERVATION_DUPLICATE_KEY')
        result[k] = v
    return result

def trusted(path):
    path = pathlib.Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('PRESERVATION_PATH')
    fd = os.open('/', os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:-1]:
            child = os.open(part, os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            st = os.fstat(fd)
            if st.st_uid != 0 or st.st_mode & 0o022:
                raise PermissionError('PRESERVATION_PARENT')
        with os.fdopen(os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd), 'rb') as f:
            a = os.fstat(f.fileno())
            if not stat.S_ISREG(a.st_mode) or a.st_uid != 0 or a.st_mode & 0o022 or a.st_nlink != 1:
                raise PermissionError('PRESERVATION_FILE')
            raw = f.read(1048577)
            b = os.fstat(f.fileno())
            stamp = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_nlink, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
            if len(raw) > 1048576 or stamp(a) != stamp(b) or stamp(a) != stamp(os.stat(path.name, dir_fd=fd, follow_symlinks=False)):
                raise ValueError('PRESERVATION_FILE_CHANGED')
            return raw
    finally:
        os.close(fd)

def required(tree):
    return (tree / 'src/engine/preservation-baseline.ts').exists() or (tree / 'dist/engine/preservation-baseline.js').exists()

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def load(path):
    return json.loads(trusted(path), object_pairs_hook=unique)

def admission(tree):
    if not required(tree):
        return None
    manifest = load(tree / 'tool/m5-manifest.json')
    if type(manifest) is not dict or set(manifest) != FILES or any(type(x) is not str or not re.fullmatch('[a-f0-9]{64}', x) for x in manifest.values()):
        raise ValueError('PRESERVATION_MANIFEST')
    installed = load(BUNDLE / 'manifest.json')
    if installed != {n: manifest[n + '.py'] for n in NAMES}:
        raise ValueError('PRESERVATION_INSTALLED_MANIFEST')
    for name, digest in manifest.items():
        if sha(trusted(tree / 'tool' / name)) != digest or sha(trusted(BUNDLE / name)) != digest:
            raise ValueError('PRESERVATION_BUNDLE_MISMATCH:' + name)
    config_raw = trusted(CONFIG)
    cfg = json.loads(config_raw,object_pairs_hook=unique)
    config_digest = sha(config_raw)
    expected_bundle = sha(json.dumps({n:manifest[n] for n in sorted(FILES-{'preservation_bundle.py'})},sort_keys=True,separators=(',',':')).encode('ascii'))
    if type(cfg) is not dict or set(cfg) != {'source','sha256','root','repositories','store','allowed_uids','socket','bundle_sha256'}:
        raise ValueError('PRESERVATION_CONFIG_SCHEMA')
    if cfg['source'] != str(BUNDLE / 'collector_windows.py') or cfg['sha256'] != manifest['collector_windows.py'] or cfg['root'] != ROOT or cfg['socket'] != SOCKET or cfg['allowed_uids'] != [993] or cfg['bundle_sha256'] != expected_bundle:
        raise ValueError('PRESERVATION_CONFIG_BINDING')
    repos = cfg['repositories']
    if type(repos) is not dict or not repos or len(set(repos.values())) != len(repos) or LIVE not in repos.values():
        raise ValueError('PRESERVATION_REGISTRY_COVERAGE')
    for alias, path in repos.items():
        if not re.fullmatch('[A-Za-z0-9-]{1,64}', alias) or type(path) is not str or os.path.realpath(path) != path or os.path.commonpath([ROOT,path]) != ROOT or not os.path.isdir(path):
            raise ValueError('PRESERVATION_REGISTRY_PATH')
    if type(cfg['store']) is not str or not os.path.isabs(cfg['store']) or os.path.realpath(cfg['store']) != cfg['store']:
        raise ValueError('PRESERVATION_STORE_PATH')
    s = os.stat(cfg['store'], follow_symlinks=False)
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != 1000 or s.st_mode & 0o077:
        raise PermissionError('PRESERVATION_STORE')
    parent = os.stat(os.path.dirname(SOCKET), follow_symlinks=False)
    sock = os.stat(SOCKET, follow_symlinks=False)
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != 1000 or parent.st_gid != 1001 or stat.S_IMODE(parent.st_mode) != 0o710:
        raise PermissionError('PRESERVATION_SOCKET_PARENT')
    if not stat.S_ISSOCK(sock.st_mode) or sock.st_uid != 1000 or sock.st_gid != 1001 or stat.S_IMODE(sock.st_mode) != 0o660:
        raise PermissionError('PRESERVATION_SOCKET')
    # No optional bypass: every admission must execute the service-UID client.
    account = pwd.getpwnam('console-mcp')
    if account.pw_uid != 993 or grp.getgrnam('smartresponse').gr_gid != 1001 or pwd.getpwnam('alex').pw_uid != 1000:
        raise PermissionError('PRESERVATION_UID_BINDING')
    # Actual candidate client under service UID, not a root connectivity probe.
    module = tree / 'dist/engine/preservation-baseline.js'
    code = ("import {pathToFileURL} from 'node:url'; "
            "const m=await import(pathToFileURL(process.argv[1]).href); "
            "const b=await m.captureOwnerBaseline(process.argv[2]); "
            "if(!b.diffCheckOk) throw Error('PRESERVATION_DIFF_CHECK'); "
            "console.log('PRESERVATION_ENGINE_PROBE_PASS')")
    result = subprocess.run(['/usr/bin/node','--input-type=module','-e',code,str(module),LIVE],
        user=account.pw_uid, group=account.pw_gid, extra_groups=[1001], cwd='/',
        env={'PATH':'/usr/bin:/bin','LC_ALL':'C','HOME':account.pw_dir,'CONSOLE_MCP_PRESERVATION_SOCKET':SOCKET,'CONSOLE_MCP_PRESERVATION_BUNDLE_SHA256':expected_bundle,'CONSOLE_MCP_PRESERVATION_CONFIG_SHA256':config_digest},
        capture_output=True, text=True, timeout=45)
    if result.returncode or result.stdout.strip() != 'PRESERVATION_ENGINE_PROBE_PASS':
        raise RuntimeError('PRESERVATION_ENGINE_PROBE_FAILED')
    if sha(trusted(CONFIG)) != config_digest:
        raise RuntimeError('PRESERVATION_CONFIG_CHANGED_DURING_PROBE')
    return (SOCKET,expected_bundle,config_digest)
