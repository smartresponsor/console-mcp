#!/usr/bin/env python3
"""Linux PTY-only integration fixture: never opens /dev/ttyUSB*, ttyACM* or hardware."""
import errno
import os
import pty
import select
import termios
import time
import tty

MAX_BYTES = 4096
TIMEOUT = 1.0


def main():
    if os.name != "posix" or not os.path.exists("/dev/ptmx"):
        print("NETWORK_PTY_UNSUPPORTED")
        return
    master, slave = pty.openpty()
    slave_path = os.ttyname(slave)
    assert slave_path.startswith("/dev/pts/"), "refuse physical device"
    try:
        # Open ONLY a kernel-generated PTY slave: no user-provided path accepted.
        transport = os.open(slave_path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        try:
            tty.setraw(transport, termios.TCSANOW)
            before = termios.tcgetattr(transport)
            assert before[4] == before[5], "unexpected asymmetric speed"
            # DTR/RTS ioctl is never performed; the only writes are to PTY master.
            payload = b"SERIAL_PTY_FIXTURE_OK\\n"
            assert len(payload) < MAX_BYTES
            assert os.write(master, payload) == len(payload)
            deadline = time.monotonic() + TIMEOUT
            data = b""
            while len(data) < len(payload) and time.monotonic() < deadline:
                ready, _, _ = select.select([transport], [], [], max(0, deadline - time.monotonic()))
                if not ready:
                    break
                try:
                    chunk = os.read(transport, MAX_BYTES + 1 - len(data))
                except BlockingIOError:
                    continue
                if not chunk:
                    break
                data += chunk
                assert len(data) <= MAX_BYTES, "PTY output cap"
            assert data == payload, repr(data)
            # Exact owned descriptor remains valid until close.
            assert os.fstat(transport).st_mode
        finally:
            os.close(transport)
            try:
                os.fstat(transport)
            except OSError as exc:
                assert exc.errno == errno.EBADF
            else:
                raise AssertionError("transport descriptor leak")
    finally:
        os.close(slave)
        os.close(master)
    print("NETWORK_LINUX_PTY_READ_ONLY_FIXTURE_PASS")


if __name__ == "__main__":
    main()
