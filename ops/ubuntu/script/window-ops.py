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
    m=re.search(r"(?:=|window id #)\s*(0x[0-9a-fA-F]+)",prop("-root","_NET_ACTIVE_WINDOW"))
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
        focused=focus()
        try:
            info=command("xwininfo","-id",focused)
            match=re.search(r"Parent window id:\s*(0x[0-9a-fA-F]+)",info)
            parent=match.group(1) if match else None
            if parent is None:
                tree=command("xwininfo","-tree","-root")
                parent="ROOT_TREE_CONTAINS_FOCUS" if focused.lower() in tree.lower() else "FOCUS_NOT_IN_ROOT_TREE"
        except (OSError,subprocess.SubprocessError):
            parent=None
        focus_properties=None
        try:
            focus_properties=prop("-id",focused,"_NET_WM_PID","WM_CLASS","_NET_WM_NAME","WM_NAME")[:600]
        except (OSError,subprocess.SubprocessError):
            focus_properties="FOCUS_WINDOW_PROPERTIES_UNAVAILABLE"
        wm=prop("-root","_NET_SUPPORTING_WM_CHECK","_NET_SUPPORTED")
        wm_check=re.search(r"_NET_SUPPORTING_WM_CHECK[^\n]*?(?:=|window id #)\s*(0x[0-9a-fA-F]+)",wm)
        supported="_NET_ACTIVE_WINDOW" in wm
        wm_name=None
        if wm_check:
            try:
                wm_name=prop("-id",wm_check.group(1),"_NET_WM_NAME","WM_NAME")[:400]
            except (OSError,subprocess.SubprocessError):
                pass
        wm_property=next((line[:400] for line in wm.splitlines() if "_NET_SUPPORTING_WM_CHECK" in line),None)
        session_type=os.environ.get("XDG_SESSION_TYPE","unknown")
        dbus_probe={"busAvailable":False,"shellIntrospection":None}
        try:
            result=subprocess.run(["/usr/bin/gdbus","introspect","--session","--dest","org.gnome.Shell","--object-path","/org/gnome/Shell"],capture_output=True,text=True,timeout=2)
            dbus_probe={"busAvailable":result.returncode==0,"shellIntrospection":("org.gnome.Shell" in result.stdout) if result.returncode==0 else None,"interfaces":[line.strip()[:140] for line in result.stdout.splitlines() if "interface " in line][:24] if result.returncode==0 else [], "shellMembers":[line.strip()[:180] for line in result.stdout.splitlines() if any(token in line for token in ("method ", "property ", "signal "))][:60] if result.returncode==0 else [], "introspectionExcerpt":result.stdout[:5000] if result.returncode==0 else None,"edgeDesktopEntries":sorted([name for name in os.listdir("/usr/share/applications") if "edge" in name.lower()])[:12] if os.path.isdir("/usr/share/applications") else []}
        except (OSError,subprocess.SubprocessError):
            pass
        modal=[]
        for item in ids:
            try:
                state=prop("-id",item,"_NET_WM_STATE","WM_TRANSIENT_FOR","_NET_WM_WINDOW_TYPE")
                if "_NET_WM_STATE_MODAL" in state or "WM_TRANSIENT_FOR(WINDOW): window id #" in state:
                    modal.append({"windowId":item,"state":state[:350]})
            except (OSError,subprocess.SubprocessError):
                continue
        return {"ok":True,"status":"WINDOW_FOCUS_INSPECTED","activeWindowId":a,"inputFocusWindowId":focused,"inputFocusParentId":parent,"inputFocusProperties":focus_properties,"activeListed":bool(a and any(int(w,16)==int(a,16) for w in ids)),"wmCheckWindowId":wm_check.group(1) if wm_check else None,"wmCheckRaw":wm_property,"wmNameRaw":wm_name,"ewmhActiveWindowSupported":supported,"sessionType":session_type,"gnomeDbus":dbus_probe,"modalOrTransientWindows":modal}
    if op == "window-focus-app-test":
        p=subprocess.run(["/usr/bin/gdbus","call","--session","--dest","org.gnome.Shell","--object-path","/org/gnome/Shell","--method","org.gnome.Shell.FocusApp","com.microsoft.Edge.desktop"],capture_output=True,text=True,timeout=3)
        time.sleep(.4)
        return {"ok":p.returncode==0,"status":"FOCUS_APP_CALLED" if p.returncode==0 else "FOCUS_APP_FAILED","dbusResult":p.stdout[:300],"dbusError":p.stderr[:500],"dbusReturnCode":p.returncode,"activeWindowId":active(),"inputFocusWindowId":focus(),"targetVerified":active()=="0x2a00004"}
    if op not in ("window-inspect","window-activate") or not window or not re.fullmatch(r"0x[0-9a-fA-F]{1,16}",window): raise ValueError()
    w=next((w for w in ids if int(w,16)==int(window,16)),None)
    if w is None:return {"ok":False,"status":"WINDOW_NOT_LISTED"}
    before=details(w)
    if op=="window-inspect":return {"ok":True,"status":"WINDOW_INSPECTED","window":before}
    if not before["isVisible"]:return {"ok":False,"status":"WINDOW_NOT_VISIBLE","windowId":w}
    script=os.path.join(os.path.dirname(__file__),"native-window-activate.py")
    activation=subprocess.run(["/usr/bin/python3",script,w],check=True,timeout=3,capture_output=True,text=True)
    native=json.loads(activation.stdout)
    for _ in range(5):
        time.sleep(.15)
        a=active()
        if a and int(a,16)==int(w,16):return {"ok":True,"status":"WINDOW_ACTIVATED","windowId":w,"activeWindowId":a,"verified":True}
    return {"ok":False,"status":"WINDOW_ACTIVATION_UNVERIFIED","windowId":w,"activeWindowId":active(),"inputFocusWindowId":focus(),"native":native,"verified":False}
if __name__=="__main__":
    try:print(json.dumps(run(sys.argv[1],sys.argv[2] if len(sys.argv)>2 else None)))
    except (ValueError,OSError,PermissionError,subprocess.SubprocessError) as e:
        print(json.dumps({"ok":False,"status":"WINDOW_OPERATION_FAILED","reason":type(e).__name__}))
