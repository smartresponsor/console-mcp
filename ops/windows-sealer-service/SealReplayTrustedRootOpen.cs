using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace ConsoleMcp.Sealer.Service;

// Opens only the fixed managed root for a genuine LocalSystem service in
// Session 0. No creation, provisioning, key access or journal mutation.
// The returned handle stays open while relative child handles are opened.
public static class SealReplayTrustedRootOpen
{
    public const string ManagedRoot = @"C:\ProgramData\ConsoleMcp";
    private const string SystemSid = "S-1-5-18";
    private const uint FileReadAttributes = 0x80;
    private const uint FileTraverse = 0x20;
    private const uint ReadControl = 0x20000;
    private const uint Synchronize = 0x100000;
    private const uint ShareRead = 1;
    private const uint ShareWrite = 2;
    private const uint OpenExisting = 3;
    private const uint BackupSemantics = 0x02000000;
    private const uint OpenReparsePoint = 0x00200000;

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string path, uint desiredAccess,
        uint shareMode, IntPtr securityAttributes, uint creationDisposition,
        uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", EntryPoint = "GetFinalPathNameByHandleW",
        CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPath(SafeFileHandle handle,
        StringBuilder path, uint capacity, uint flags);

    public static SafeFileHandle? Open()
    {
        if (!OperatingSystem.IsWindows())
            return null;
        using WindowsIdentity token = WindowsIdentity.GetCurrent();
        if (token.User?.Value != SystemSid ||
            System.Diagnostics.Process.GetCurrentProcess().SessionId != 0)
            return null;

        SafeFileHandle? handle = null;
        try
        {
            handle = CreateFile(ManagedRoot,
                ReadControl | FileReadAttributes | FileTraverse | Synchronize,
                ShareRead | ShareWrite, IntPtr.Zero, OpenExisting,
                BackupSemantics | OpenReparsePoint, IntPtr.Zero);
            if (handle.IsInvalid ||
                !SealReplayDirectoryHandleAdmission.Verify(handle, SystemSid))
                return null;
            var buffer = new StringBuilder(1024);
            uint length = GetFinalPath(handle, buffer, (uint)buffer.Capacity, 0);
            if (length == 0 || length >= buffer.Capacity ||
                !string.Equals(buffer.ToString(), @"\\?\C:\ProgramData\ConsoleMcp",
                    StringComparison.OrdinalIgnoreCase))
                return null;

            SafeFileHandle accepted = handle;
            handle = null;
            return accepted;
        }
        catch (Exception ex) when (ex is ArgumentException or IOException or
            UnauthorizedAccessException or ObjectDisposedException or
            System.Security.SecurityException)
        {
            return null;
        }
        finally
        {
            handle?.Dispose();
        }
    }
}
