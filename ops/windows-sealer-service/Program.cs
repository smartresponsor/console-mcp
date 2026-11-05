using System.Runtime.InteropServices;
using System.Security.Principal;

namespace ConsoleMcp.Sealer.Service;

// Minimal SCM-native process. It has NO transport, sealing operations, key
// loading, release filesystem mutations, or self-installation path.
internal static class Program
{
    private const string ServiceName = "ConsoleMcpReleaseSealerV3";
    private const uint ServiceWin32OwnProcess = 0x10;
    private const uint ServiceStopped = 1;
    private const uint ServiceStartPending = 2;
    private const uint ServiceStopPending = 3;
    private const uint ServiceRunning = 4;
    private const uint ServiceAcceptStop = 1;
    private const uint ServiceControlStop = 1;
    private const uint ServiceControlInterrogate = 4;
    private const uint ErrorServiceSpecificError = 1066;
    private const uint ErrorAccessDenied = 5;

    private delegate void ServiceMainDelegate(uint argc, IntPtr argv);
    private delegate uint HandlerExDelegate(uint control, uint eventType, IntPtr eventData, IntPtr context);

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceTableEntry
    {
        public IntPtr ServiceName;
        public IntPtr ServiceProc;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceStatus
    {
        public uint ServiceType;
        public uint CurrentState;
        public uint ControlsAccepted;
        public uint Win32ExitCode;
        public uint ServiceSpecificExitCode;
        public uint CheckPoint;
        public uint WaitHint;
    }

    [DllImport("advapi32.dll", EntryPoint = "StartServiceCtrlDispatcherW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool StartServiceCtrlDispatcher([In] ServiceTableEntry[] table);

    [DllImport("advapi32.dll", EntryPoint = "RegisterServiceCtrlHandlerExW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr RegisterServiceCtrlHandlerEx(string serviceName, HandlerExDelegate handler, IntPtr context);

    [DllImport("advapi32.dll", EntryPoint = "SetServiceStatus", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetServiceStatus(IntPtr serviceHandle, ref ServiceStatus status);

    private static readonly ServiceMainDelegate ServiceMainCallback = ServiceMain;
    private static readonly HandlerExDelegate ControlCallback = HandleControl;
    private static readonly ManualResetEventSlim StopEvent = new(false);
    private static readonly object StatusLock = new();
    private static IntPtr _statusHandle;
    private static uint _state = ServiceStopped;

    private static int Main(string[] args)
    {
        // Never provide a debug, CLI, console or --install fallback.
        if (!OperatingSystem.IsWindows() || args.Length != 0)
            return (int)ErrorAccessDenied;

        // Only an actual LocalSystem service process in Session 0 may register.
        using WindowsIdentity identity = WindowsIdentity.GetCurrent();
        if (identity.User?.Value != "S-1-5-18" || System.Diagnostics.Process.GetCurrentProcess().SessionId != 0)
            return (int)ErrorAccessDenied;

        IntPtr name = Marshal.StringToHGlobalUni(ServiceName);
        IntPtr proc = Marshal.GetFunctionPointerForDelegate(ServiceMainCallback);
        try
        {
            ServiceTableEntry[] table = { new ServiceTableEntry { ServiceName = name, ServiceProc = proc }, default };
            if (!StartServiceCtrlDispatcher(table))
                return Marshal.GetLastWin32Error();
            return 0;
        }
        finally
        {
            Marshal.FreeHGlobal(name);
            GC.KeepAlive(ServiceMainCallback);
        }
    }

    private static void ServiceMain(uint argc, IntPtr argv)
    {
        _statusHandle = RegisterServiceCtrlHandlerEx(ServiceName, ControlCallback, IntPtr.Zero);
        if (_statusHandle == IntPtr.Zero)
            return;

        SetState(ServiceStartPending, 0, 1);
        // Fail closed: no request listener or service key until dedicated
        // authenticated transport, replay journal and key custody are reviewed.
        SetState(ServiceRunning, ServiceAcceptStop, 0);
        StopEvent.Wait();
        SetState(ServiceStopped, 0, 0);
    }

    private static uint HandleControl(uint control, uint eventType, IntPtr eventData, IntPtr context)
    {
        switch (control)
        {
            case ServiceControlStop:
                SetState(ServiceStopPending, 0, 1);
                StopEvent.Set();
                return 0;
            case ServiceControlInterrogate:
                lock (StatusLock)
                    PublishStatus(_state, _state == ServiceRunning ? ServiceAcceptStop : 0, 0);
                return 0;
            default:
                return ErrorAccessDenied;
        }
    }

    private static void SetState(uint state, uint accepted, uint checkpoint)
    {
        lock (StatusLock)
        {
            _state = state;
            PublishStatus(state, accepted, checkpoint);
        }
    }

    private static void PublishStatus(uint state, uint accepted, uint checkpoint)
    {
        ServiceStatus status = new()
        {
            ServiceType = ServiceWin32OwnProcess,
            CurrentState = state,
            ControlsAccepted = accepted,
            Win32ExitCode = 0,
            ServiceSpecificExitCode = 0,
            CheckPoint = checkpoint,
            WaitHint = checkpoint == 0 ? 0u : 3000u
        };
        if (!SetServiceStatus(_statusHandle, ref status))
            throw new InvalidOperationException("RELEASE_SEAL_SCM_STATUS_FAILED");
    }
}
