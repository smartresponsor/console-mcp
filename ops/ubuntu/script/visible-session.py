#!/usr/bin/python3
"""Resolve the one local graphical login, using GNOME's imported environment."""
import os
import subprocess

def session():
    found = []
    for line in subprocess.check_output(['loginctl', 'list-sessions', '--no-legend'], text=True).splitlines():
        sid = line.split()[0]
        props = dict(line.split('=', 1) for line in subprocess.check_output(
            ['loginctl', 'show-session', sid, '-p', 'Id', '-p', 'User', '-p', 'Name',
             '-p', 'Display', '-p', 'Type', '-p', 'Remote', '-p', 'Class', '-p', 'Active', '-p', 'LockedHint'],
            text=True, timeout=3).splitlines() if '=' in line)
        if (props.get('User') == str(os.getuid()) and props.get('Remote') == 'no'
                and props.get('Class') == 'user' and props.get('Type') == 'x11'):
            found.append(props)
    if len(found) != 1 or os.getuid() != 1000:
        raise RuntimeError('Exactly one alex X11 login required')
    displays = set()
    for proc in __import__('pathlib').Path('/proc').glob('[0-9]*'):
        try:
            if proc.stat().st_uid != os.getuid() or f"/session-{found[0]['Id']}.scope" not in (proc / 'cgroup').read_text():
                continue
            env = dict(v.split('=', 1) for v in (proc / 'environ').read_text().split('\0') if '=' in v)
            if env.get('DISPLAY') and env.get('XAUTHORITY') == os.environ.get('XAUTHORITY'):
                displays.add(env['DISPLAY'])
        except (OSError, ValueError):
            pass
    if displays != {os.environ.get('DISPLAY')} or os.environ.get('XAUTHORITY') != '/run/user/1000/gdm/Xauthority' or os.environ.get('XDG_RUNTIME_DIR') != '/run/user/1000':
        raise RuntimeError('GNOME graphical environment not imported')
    if os.stat(os.environ['XAUTHORITY']).st_uid != os.getuid():
        raise RuntimeError('Wrong Xauthority owner')
    return found[0]
