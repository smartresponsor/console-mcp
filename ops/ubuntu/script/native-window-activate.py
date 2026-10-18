#!/usr/bin/python3
"""Send an EWMH request to activate one already verified native X11 window."""
import ctypes
import json
import subprocess
import time
import os
import re
import sys

def main():
    if len(sys.argv) != 2 or not re.fullmatch(r"0x[0-9a-fA-F]{1,16}", sys.argv[1]):
        raise SystemExit(64)
    if os.getuid() != 1000 or os.environ.get("CONSOLE_MCP_DESKTOP_LOCAL") != "1":
        raise SystemExit(64)
    if not os.environ.get("DISPLAY") or not os.environ.get("XAUTHORITY"):
        raise SystemExit(65)
    x11 = ctypes.CDLL("libX11.so.6")
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    x11.XDefaultRootWindow.restype = ctypes.c_ulong
    x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    x11.XInternAtom.restype = ctypes.c_ulong
    x11.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.c_void_p]
    x11.XSendEvent.restype = ctypes.c_int
    x11.XFlush.argtypes = [ctypes.c_void_p]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    class Data(ctypes.Union):
        _fields_ = [("l", ctypes.c_long * 5), ("b", ctypes.c_char * 20)]
    class Client(ctypes.Structure):
        _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong), ("send_event", ctypes.c_int),
                    ("display", ctypes.c_void_p), ("window", ctypes.c_ulong),
                    ("message_type", ctypes.c_ulong), ("format", ctypes.c_int), ("data", Data)]
    # XSendEvent consumes a full 192-byte XEvent, not a bare Client struct.
    class XEvent(ctypes.Union):
        _fields_ = [("xclient", Client), ("padding", ctypes.c_long * 24)]
    display = x11.XOpenDisplay(None)
    if not display:
        raise SystemExit(66)
    try:
        atom = x11.XInternAtom(display, b"_NET_ACTIVE_WINDOW", 0)
        if not atom:
            raise SystemExit(67)
        event_buffer = XEvent()
        event = event_buffer.xclient
        event.type = 33
        event.send_event = 1
        event.display = display
        event.window = int(sys.argv[1], 16)
        event.message_type = atom
        event.format = 32
        event.data.l[0] = 2  # pager-style request from authorized desktop controller
        event.data.l[1] = 0  # CurrentTime; no fabricated user interaction timestamp
        event.data.l[2] = 0
        if not x11.XSendEvent(display, x11.XDefaultRootWindow(display), 0,
                             (1 << 19) | (1 << 20), ctypes.byref(event_buffer)):
            raise SystemExit(68)
        x11.XFlush(display)
        # Read-only observation: XSendEvent success does not imply WM activation.
        def active_window():
            p = subprocess.run(["xprop", "-root", "_NET_ACTIVE_WINDOW"],
                               capture_output=True, text=True, timeout=2, check=False)
            m = re.search(r"(?:=|window id #)\s*(0x[0-9a-fA-F]+)", p.stdout)
            return int(m.group(1), 16) if m else None
        requested = int(sys.argv[1], 16)
        observed = active_window()
        if observed != requested:
            time.sleep(0.25)
            observed = active_window()
        # Bounded Xlib fallback: only the already validated target, never arbitrary windows.
        direct_focus_attempted = False
        if observed != requested:
            x11.XRaiseWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
            x11.XSetInputFocus.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
            x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
            x11.XRaiseWindow(display, requested)
            x11.XSetInputFocus(display, requested, 1, 0)
            x11.XSync(display, 0)
            direct_focus_attempted = True
        print(json.dumps({"direct_focus_attempted": direct_focus_attempted, "request_sent": True, "active_window_matches": observed == requested,
                          "active_window_present": observed is not None}))
    finally:
        x11.XCloseDisplay(display)

if __name__ == "__main__":
    main()
