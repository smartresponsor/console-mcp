#!/usr/bin/env python3
"""Network M2: Linux kernel PTY FD binding acceptance, no physical serial access.

Exercises O_NOCTTY | O_NONBLOCK | O_CLOEXEC and fstat on kernel-allocated
/dev/pts/* only. This is a regression fixture, NOT a privileged serial backend.
No ioctl changing DTR/RTS, no login, no write to the slave / application port.
"""
import errno
import os
import pty
import select
import stat
import termios
import time
import tty

MAX_BYTES = 128
TIMEOUT_SECONDS = 0.15


def closed(fd):
    try:
        os.fstat(fd)
    except OSError as exc:
        assert exc.errno == errno.EBADF, f"unexpected close errno: {exc.errno}"
    else:
        raise AssertionError("PTY descriptor leak")


def identity(fd):
    info = os.fstat(fd)
    assert stat.S_ISCHR(info.st_mode), "not a char device"
    return (info.st_dev, info.st_ino, info.st_rdev)


def bounded_read(fd, limit=MAX_BYTES, timeout=TIMEOUT_SECONDS):
    if type(limit) is not int or not 1 <= limit <= MAX_BYTES:
        raise ValueError("invalid cap")
    if not isinstance(timeout, (float, int)) or type(timeout) is bool or not 0 < timeout <= 0.5:
        raise ValueError("invalid timeout")
    started = time.monotonic()
    result = bytearray()
    while len(result) < limit:
        remaining = timeout - (time.monotonic() - started)
        if remaining <= 0:
            return "timeout", bytes(result)
        ready, _, _ = select.select([fd], [], [], remaining)
        if not ready:
            return "timeout", bytes(result)
        try:
            chunk = os.read(fd, min(32, limit - len(result)))
        except BlockingIOError:
            continue
        except OSError as exc:
            if exc.errno == errno.EIO:
                return "disconnected", bytes(result)
            raise
        if not chunk:
            return "disconnected", bytes(result)
        result.extend(chunk)
    return "bounded", bytes(result)


def run():
    master, slave = pty.openpty()
    transport = None
    other_master = other_slave = None
    try:
        path = os.ttyname(slave)
        assert path.startswith("/dev/pts/") and path[9:].isdigit(), "non PTY path rejected"
        flags = os.O_RDONLY | os.O_NONBLOCK | os.O_NOCTTY | os.O_CLOEXEC
        # No untrusted path is passed to open(); the PTY slave path is created by the kernel.
        transport = os.open(path, flags)
        tty.setraw(slave, termios.TCSANOW)  # configure fixture slave only
        original = identity(slave)
        assert identity(transport) == original
        assert os.get_inheritable(transport) is False
        assert os.get_blocking(transport) is False
        # Compare a *live open handle*, not a lexical path or stale file name.
        os.write(master, b"TEST-DEVICE READY\r\n")
        status, data = bounded_read(transport, limit=19)
        assert (status, data) == ("bounded", b"TEST-DEVICE READY\r\n")
        assert identity(transport) == original, "same handle changed identity"

        # A separate PTY must not be accepted as the original session.
        other_master, other_slave = pty.openpty()
        assert identity(other_slave) != original, "distinct PTYs share fd identity"
        assert identity(transport) == original

        # No input yields a bounded read deadline.
        t0 = time.monotonic()
        assert bounded_read(transport, timeout=0.03) == ("timeout", b"")
        assert time.monotonic() - t0 < 0.3

        # Partial output is always capped and returned only with a timeout.
        os.write(master, b"A" * 256)
        status, data = bounded_read(transport, limit=MAX_BYTES)
        assert status == "bounded" and data == b"A" * MAX_BYTES

        # Closing master disconnects the slave; no indefinite blocking.
        os.close(master)
        master = None
        status, _ = bounded_read(transport, limit=5, timeout=0.05)
        assert status == "disconnected"

        for invalid in (0, -1, MAX_BYTES + 1, True, 1.2):
            try:
                bounded_read(transport, limit=invalid)
            except ValueError:
                pass
            else:
                raise AssertionError("invalid cap accepted")
    finally:
        if transport is not None:
            os.close(transport)
            closed(transport)
        os.close(slave)
        closed(slave)
        if master is not None:
            os.close(master)
            closed(master)
        if other_slave is not None:
            os.close(other_slave)
            closed(other_slave)
        if other_master is not None:
            os.close(other_master)
            closed(other_master)
    print("NETWORK_PTY_HANDLE_IDENTITY_AND_CLEANUP_PASS")


if __name__ == "__main__":
    assert os.name == "posix"
    run()
