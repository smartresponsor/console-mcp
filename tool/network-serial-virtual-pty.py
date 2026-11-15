#!/usr/bin/env python3
"""Hardware-free Linux pseudo-terminal transport smoke; no real serial devices."""
import os
import pty
import select
import tty

def run():
    master, slave = pty.openpty()
    try:
        assert os.isatty(master) and os.isatty(slave)
        assert os.ttyname(slave).startswith("/dev/pts/")
        tty.setraw(slave, when=tty.TCSANOW)
        assert not select.select([slave], [], [], 0)[0], "unexpected data before fixture"
        payload = b"virtual-switch: ready\n"
        assert os.write(master, payload) == len(payload)
        assert select.select([slave], [], [], 1.0)[0], "fixture byte stream timed out"
        assert os.read(slave, 1024) == payload
        assert not select.select([slave], [], [], 0)[0], "unexpected trailing data"
        print("NETWORK_SERIAL_VIRTUAL_PTY_PASS")
    finally:
        os.close(slave)
        os.close(master)

if __name__ == "__main__":
    run()
