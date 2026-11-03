using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace ConsoleMcp.Sealer.Service;

// Child-only NT directory open relative to a previously verified parent
// handle. Never follows a reparse point and never grants delete sharing.
// Caller retains every opened handle and verifies ACL/identity on each one.
public static class SealReplayRelativeDirectoryOpen
{
    private const uint ReadControl = 0x00020000;
    private const uint FileReadAttributes = 0x00000080;
    private const uint FileTraverse = 0x00000020;
    private const uint FileAddFile = 0x00000002;
    private const uint Synchronize = 0x00100000;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint FileOpen = 0x00000001;
    private const uint FileDirectoryFile = 0x00000001;
    private const uint FileOpenReparsePoint = 0x00200000;
    private const uint FileSynchronousIoNonAlert = 0x00000020;
    private const uint ObjCaseInsensitive = 0x00000040;

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeString
    {
        public ushort Length;
        public ushort MaximumLength;
        public IntPtr Buffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ObjectAttributes
    {
        public uint Length;
        public IntPtr RootDirectory;
        public IntPtr ObjectName;
        public uint Attributes;
        public IntPtr SecurityDescriptor;
        public IntPtr SecurityQualityOfService;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoStatusBlock
    {
        public IntPtr Status;
        public IntPtr Information;
    }

    [DllImport("ntdll.dll", ExactSpelling = true)]
    private static extern int NtOpenFile(out SafeFileHandle fileHandle, uint desiredAccess,
        ref ObjectAttributes objectAttributes, out IoStatusBlock ioStatus,
        uint shareAccess, uint openOptions);

    public static SafeFileHandle? OpenChild(SafeFileHandle parent, string childName)
    {
        if (!OperatingSystem.IsWindows() || parent is null ||
            parent.IsInvalid || parent.IsClosed ||
            childName is not ("seal-authority" or "replay-journal"))
            return null;

        bool referenceAdded = false;
        IntPtr nameBuffer = IntPtr.Zero;
        IntPtr namePointer = IntPtr.Zero;
        SafeFileHandle? result = null;
        try
        {
            parent.DangerousAddRef(ref referenceAdded);
            nameBuffer = Marshal.StringToHGlobalUni(childName);
            var unicode = new UnicodeString
            {
                Length = checked((ushort)(childName.Length * 2)),
                MaximumLength = checked((ushort)((childName.Length + 1) * 2)),
                Buffer = nameBuffer
            };
            namePointer = Marshal.AllocHGlobal(Marshal.SizeOf<UnicodeString>());
            Marshal.StructureToPtr(unicode, namePointer, false);
            var attributes = new ObjectAttributes
            {
                Length = (uint)Marshal.SizeOf<ObjectAttributes>(),
                RootDirectory = parent.DangerousGetHandle(),
                ObjectName = namePointer,
                Attributes = ObjCaseInsensitive
            };
            uint access = ReadControl | FileReadAttributes | FileTraverse | Synchronize;
            if (childName == "replay-journal")
                access |= FileAddFile;
            int status = NtOpenFile(out result, access, ref attributes, out _,
                FileShareRead | FileShareWrite,
                FileDirectoryFile | FileOpenReparsePoint | FileSynchronousIoNonAlert);
            if (status < 0 || result.IsInvalid)
            {
                result?.Dispose();
                return null;
            }
            SafeFileHandle opened = result;
            result = null;
            return opened;
        }
        catch (Exception ex) when (ex is ArgumentException or
               OverflowException or UnauthorizedAccessException or ObjectDisposedException)
        {
            return null;
        }
        finally
        {
            result?.Dispose();
            if (namePointer != IntPtr.Zero) Marshal.FreeHGlobal(namePointer);
            if (nameBuffer != IntPtr.Zero) Marshal.FreeHGlobal(nameBuffer);
            if (referenceAdded) parent.DangerousRelease();
        }
    }
}
