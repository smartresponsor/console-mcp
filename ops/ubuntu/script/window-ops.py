#!/usr/bin/python3
"""User-owned bounded X11 window diagnostics and activation."""
import ctypes, json, os, re, subprocess, sys, time

def command(*args):
    return subprocess.check_output(args, text=True, timeout=3, stderr=subprocess.DEVNULL)
def prop(*args):
    return command("xprop", *args)
def inventory():
    s=prop("-root","_NET_CLIENT_LIST")
    line=next((x for x in s.splitlines() if x.startswith("_NET_CLIENT_LIST(")),"")
    return list(dict.fromkeys(re.findall(r"0x[0-9a-fA-F]+",line)))[:128]
def active():
    m=re.search(r"=\s*(0x[0-9a-fA-F]+)",prop("-root","_NET_ACTIVE_WINDOW"))
    return m.group(1) if m else None
def focus():
    x=ctypes.CDLL("libX11.so.6")
    x.XOpenDisplay.argtypes=[ctypes.c_char_p];x.XOpenDisplay.restype=ctypes.c_void_p
    x.XGetInputFocus.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_ulong),ctypes.POINTER(ctypes.c_int)]
    x.XCloseDisplay.argtypes=[ctypes.c_void_p]
    d=x.XOpenDisplay(None)
    if not d: raise OSError("DISPLAY unavailable")
    try:
        w=ctypes.c_ulong(); rev=ctypes.c_int()
        x.XGetInputFocus(d,ctypes.byref(w),ctypes.byref(rev))
        return hex(w.value)
    finally: x.XCloseDisplay(d)
def details(w):
    raw=prop("-id",w,"_NET_WM_PID","WM_CLASS","_NET_WM_NAME","WM_NAME","_NET_WM_STATE","_NET_WM_DESKTOP")
    info=command("xwininfo","-id",w)
    def field(k):
        m=re.search(r"^"+re.escape(k)+r"(?:\([^\n]*\))?\s*=\s*(.+)$",raw,re.M)
        return m.group(1)[:250] if m else None
    def num(k):
        m=re.search(r"^\s*"+re.escape(k)+r":\s*(-?\d+)",info,re.M)
        return int(m.group(1)) if m else None
    pid=field("_NET_WM_PID")
    current=active()
    return {"windowId":w,"pid":int(pid) if pid and pid.isdecimal() else None,
      "title":field("_NET_WM_NAME") or field("WM_NAME"),"wmClass":field("WM_CLASS"),
      "desktop":field("_NET_WM_DESKTOP"),
      "isActive":bool(current and int(current,16)==int(w,16)),
      "isFocused":int(focus(),16)==int(w,16),
      "isVisible":"Map State: IsViewable" in info and "_NET_WM_STATE_HIDDEN" not in raw,
      "isMinimized":"_NET_WM_STATE_HIDDEN" in raw,
      "geometry":{"x":num("Absolute upper-left X"),"y":num("Absolute upper-left Y"),"width":num("Width"),"height":num("Height")}}
def run(op,window):
    if os.getuid()!=1000 or os.environ.get("CONSOLE_MCP_DESKTOP_LOCAL")!="1": raise PermissionError()
    ids=inventory()
    if op=="window-inventory":
        return {"ok":True,"status":"WINDOW_INVENTORY_READY","windows":[details(w) for w in ids],"count":len(ids)}
    if op=="window-inspect-focus":
        a=active()
        return {"ok":True,"status":"WINDOW_FOCUS_INSPECTED","activeWindowId":a,"inputFocusWindowId":focus(),"activeListed":bool(a and any(int(w,16)==int(a,16) for w in ids))}
    if op not in ("window-inspect","window-activate") or not window or not re.fullmatch(r"0x[0-9a-fA-F]{1,16}",window): raise ValueError()
    w=next((w for w in ids if int(w,16)==int(window,16)),None)
    if w is None:return {"ok":False,"status":"WINDOW_NOT_LISTED"}
    before=details(w)
    if op=="window-inspect":return {"ok":True,"status":"WINDOW_INSPECTED","window":before}
    if not before["isVisible"]:return {"ok":False,"status":"WINDOW_NOT_VISIBLE","windowId":w}
    script=os.path.join(os.path.dirname(__file__),"native-window-activate.py")
    subprocess.run(["/usr/bin/python3",script,w],check=True,timeout=3,stdout=subprocess.DEVNULL)
    for _ in range(5):
        time.sleep(.15)
        a=active()
        if a and int(a,16)==int(w,16):return {"ok":True,"status":"WINDOW_ACTIVATED","windowId":w,"activeWindowId":a,"verified":True}
    return {"ok":False,"status":"WINDOW_ACTIVATION_UNVERIFIED","windowId":w,"activeWindowId":active(),"verified":False}
if __name__=="__main__":
    try:print(json.dumps(run(sys.argv[1],sys.argv[2] if len(sys.argv)>2 else None)))
    except (ValueError,OSError,PermissionError,subprocess.SubprocessError) as e:
        print(json.dumps({"ok":False,"status":"WINDOW_OPERATION_FAILED","reason":type(e).__name__}))
