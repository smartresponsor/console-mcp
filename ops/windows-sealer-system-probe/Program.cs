using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
using ConsoleMcp.Sealer.Service;

internal static class Program
{
    // Separate, test-only SCM identity: it must never impersonate the sealer.
    private const string ServiceName = "ConsoleMcpJournalProbeFixture";
    private static readonly ManualResetEventSlim Stopping = new(false);
    private static readonly ServiceMainDelegate MainCallback = ServiceMain;
    private static readonly ControlDelegate StopCallback = Control;
    private static IntPtr _status;

    private delegate void ServiceMainDelegate(uint argc, IntPtr argv);
    private delegate uint ControlDelegate(uint control, uint eventType, IntPtr data, IntPtr context);

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceEntry { public IntPtr Name; public IntPtr Handler; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceStatus
    {
        public uint Type, State, Accepted, Win32Exit, ServiceExit, Checkpoint, WaitHint;
    }
    [DllImport("advapi32.dll", EntryPoint = "StartServiceCtrlDispatcherW",
        CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool StartDispatcher([In] ServiceEntry[] entries);
    [DllImport("advapi32.dll", EntryPoint = "RegisterServiceCtrlHandlerExW",
        CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr RegisterHandler(string name, ControlDelegate handler, IntPtr context);
    [DllImport("advapi32.dll", EntryPoint = "SetServiceStatus", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Publish(IntPtr handle, ref ServiceStatus status);
    [DllImport("kernel32.dll", EntryPoint = "CreateFileW",
        CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle OpenDirectory(string path, uint access, uint sharing,
        IntPtr security, uint creation, uint options, IntPtr template);

    private static int Main(string[] args)
    {
        if (!OperatingSystem.IsWindows() || args.Length != 0) return 5;
        using WindowsIdentity id = WindowsIdentity.GetCurrent();
        if (id.User?.Value != "S-1-5-18" ||
            System.Diagnostics.Process.GetCurrentProcess().SessionId != 0) return 5;

        IntPtr name = Marshal.StringToHGlobalUni(ServiceName);
        try
        {
            ServiceEntry[] table = [new() {
                Name = name, Handler = Marshal.GetFunctionPointerForDelegate(MainCallback)
            }, default];
            return StartDispatcher(table) ? 0 : Marshal.GetLastWin32Error();
        }
        finally { Marshal.FreeHGlobal(name); GC.KeepAlive(MainCallback); }
    }

    private static void SetStatus(uint state, uint accepted = 0, uint exit = 0)
    {
        ServiceStatus value = new() {
            Type = 0x10, State = state, Accepted = accepted,
            Win32Exit = exit, WaitHint = state == 2 ? 3000u : 0u
        };
        if (!Publish(_status, ref value)) throw new InvalidOperationException("SCM_STATUS_FAILED");
    }

    private static void ServiceMain(uint argc, IntPtr argv)
    {
        _status = RegisterHandler(ServiceName, StopCallback, IntPtr.Zero);
        if (_status == IntPtr.Zero) return;
        SetStatus(2);
        // Only an isolated fixture-relative tree. No production ProgramData,
        // keys, claim file, release mutation, listener or broker connection.
        string root = Path.Combine(AppContext.BaseDirectory, "probe-root");
        using SafeFileHandle handle = OpenDirectory(root, 0x001200A0,
            0x3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        bool accepted = !handle.IsInvalid &&
            SealReplayDirectoryHandleAdmission.Verify(handle, "S-1-5-18");
        using (var chain = accepted
            ? SealReplayVerifiedChain.OpenFromAttestedRoot(
                handle, root, "S-1-5-18") : null)
        {
            accepted = chain is { IsOpen: true } &&
                chain.VerifyAgain(root, "S-1-5-18");
            // A fresh fixture-only receipt is written solely on success.
            if (accepted)
                File.WriteAllText(Path.Combine(AppContext.BaseDirectory, "probe-pass.txt"),
                    "SYSTEM_HANDLE_CHAIN_PASS\n", System.Text.Encoding.ASCII);
        }
        if (!accepted) { SetStatus(1, 0, 5); return; }
        SetStatus(4, 1);
        Stopping.Wait();
        SetStatus(1);
    }

    private static uint Control(uint control, uint eventType, IntPtr data, IntPtr context)
    {
        if (control != 1) return 5;
        Stopping.Set();
        return 0;
    }
}
