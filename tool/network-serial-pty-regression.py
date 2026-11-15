#!/usr/bin/env python3
"""Offline Linux PTY regression. No real ttyUSB/ttyACM/COM opens or modem ioctls."""
import errno
import os
import pty
import select
import termios
import time
import tty

TARGET = "virtual-pty-test-only"
PROFILE = "passive-8n1-9600"


def guard(target, profile, command=None):
    if target != TARGET:
        raise ValueError("SERIAL_TARGET_NOT_AUTHORIZED")
    if profile != PROFILE:
        raise ValueError("SERIAL_PROFILE_NOT_AUTHORIZED")
    if command is not None:
        raise ValueError("SERIAL_COMMANDS_FORBIDDEN")


def capture(fd, limit=128, timeout=.4, canceled=lambda: False):
    if type(limit) is not int or not 1 <= limit <= 128:
        raise ValueError("INVALID_LIMIT")
    if not isinstance(timeout, (int, float)) or not 0 < timeout <= .4:
        raise ValueError("INVALID_TIMEOUT")
    result = bytearray()
    end = time.monotonic() + timeout
    while True:
        if canceled():
            return "canceled", bytes(result)
        remaining = end - time.monotonic()
        if remaining <= 0:
            return "timeout", bytes(result)
        ready, _, _ = select.select([fd], [], [], min(.02, remaining))
        if not ready:
            continue
        try:
            data = os.read(fd, min(32, limit - len(result)))
        except OSError as exc:
            if exc.errno == errno.EIO:
                return "disconnected", bytes(result)
            raise
        if not data:
            return "disconnected", bytes(result)
        result.extend(data)
        if len(result) == limit:
            return "bounded", bytes(result)


def pair():
    m, s = pty.openpty()
    tty.setraw(s, termios.TCSANOW)
    return m, s


def check(expected, injected, limit, timeout=.2, close_master=False):
    m, s = pair()
    try:
        if close_master:
            os.close(m)
            m = -1
        else:
            os.write(m, injected)
        status, payload = capture(s, limit=limit, timeout=timeout)
        assert status == expected, (status, expected)
        return payload
    finally:
        os.close(s)
        if m >= 0:
            os.close(m)


def run():
    checks = []
    for target, profile, cmd, message in (
        ("/dev/ttyUSB0", PROFILE, None, "SERIAL_TARGET_NOT_AUTHORIZED"),
        (TARGET, "unapproved-baud", None, "SERIAL_PROFILE_NOT_AUTHORIZED"),
        (TARGET, PROFILE, "show running-config", "SERIAL_COMMANDS_FORBIDDEN"),
    ):
        try:
            guard(target, profile, cmd)
        except ValueError as e:
            assert str(e) == message
        else:
            raise AssertionError("unsafe target/profile/command admitted")
        checks.append(message)
    guard(TARGET, PROFILE)
    assert check("bounded", b"TEST-DEVICE READY\r\n", 19) == b"TEST-DEVICE READY\r\n"
    checks.append("PASSIVE_BANNER")
    assert check("bounded", b"A" * 256, 64) == b"A" * 64
    checks.append("OUTPUT_BOUND")
    m, s = pair()
    try:
        start = time.monotonic()
        assert capture(s, timeout=.05) == ("timeout", b"")
        assert time.monotonic() - start < .3
        assert capture(s, canceled=lambda: True) == ("canceled", b"")
    finally:
        os.close(m)
        os.close(s)
    checks += ["DEADLINE", "CANCELLATION"]
    assert check("disconnected", b"", 32, close_master=True) == b""
    checks.append("DISCONNECT")
    assert check("bounded", b"\xff\x00\xfe\n", 4) == b"\xff\x00\xfe\n"
    checks.append("MALFORMED_BYTES")
    assert len(checks) == 9
    print("NETWORK_SERIAL_PTY_ACCEPTANCE_PASS", ",".join(checks))


if __name__ == "__main__":
    assert os.name == "posix"
    run()
