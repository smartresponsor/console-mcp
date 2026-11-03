using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace ConsoleMcp.Sealer.Service;

// Native root-handle-relative CREATE_NEW. The root handle MUST already be
// opened and independently admitted by the privileged caller. No pathname
// is resolved between admission and child creation.
// This module does not install a service, authorize sealing or open key files.
public static class SealReplayHandleClaim
{
    private const uint FileWriteData = 0x00000002;
    private const uint Synchronize = 0x00100000;
    private const uint FileCreate = 0x00000002;
    private const uint FileNonDirectoryFile = 0x00000040;
    private const uint FileWriteThrough = 0x00000002;
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
    private static extern int NtCreateFile(
        out SafeFileHandle fileHandle,
        uint desiredAccess,
        ref ObjectAttributes objectAttributes,
        out IoStatusBlock ioStatus,
        IntPtr allocationSize,
        uint fileAttributes,
        uint shareAccess,
        uint createDisposition,
        uint createOptions,
        IntPtr eaBuffer,
        uint eaLength);

    // Excludes both DOS separators and any alternate-stream delimiter.
    private static bool ValidId(string? id) =>
        id is { Length: 32 } && id.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');

    public static bool TryClaim(SafeFileHandle admittedDirectory, string requestId)
    {
        if (!OperatingSystem.IsWindows() || admittedDirectory is null ||
            admittedDirectory.IsInvalid || admittedDirectory.IsClosed || !ValidId(requestId))
            return false;

        string name = requestId + ".claim";
        IntPtr nameBuffer = IntPtr.Zero;
        IntPtr unicodeAddress = IntPtr.Zero;
        SafeFileHandle? output = null;
        byte[] record = Encoding.ASCII.GetBytes("console-mcp-replay-v1\n" + requestId + "\n");
        bool addedReference = false;
        try
        {
            // Keep the exact admitted handle alive across the native create.
            admittedDirectory.DangerousAddRef(ref addedReference);
            nameBuffer = Marshal.StringToHGlobalUni(name);
            var unicode = new UnicodeString
            {
                Length = checked((ushort)(name.Length * 2)),
                MaximumLength = checked((ushort)((name.Length + 1) * 2)),
                Buffer = nameBuffer
            };
            unicodeAddress = Marshal.AllocHGlobal(Marshal.SizeOf<UnicodeString>());
            Marshal.StructureToPtr(unicode, unicodeAddress, false);
            var attributes = new ObjectAttributes
            {
                Length = (uint)Marshal.SizeOf<ObjectAttributes>(),
                RootDirectory = admittedDirectory.DangerousGetHandle(),
                ObjectName = unicodeAddress,
                Attributes = ObjCaseInsensitive
            };
            int status = NtCreateFile(out output,
                FileWriteData | Synchronize, ref attributes, out _,
                IntPtr.Zero, 0, 0, FileCreate,
                FileNonDirectoryFile | FileWriteThrough | FileSynchronousIoNonAlert,
                IntPtr.Zero, 0);
            if (status < 0 || output is null || output.IsInvalid)
                return false;
            using (var stream = new FileStream(output, FileAccess.Write))
            {
                output = null;
                stream.Write(record);
                stream.Flush(flushToDisk: true);
            }
            return true;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or
               ArgumentException or OverflowException or ObjectDisposedException)
        {
            return false;
        }
        finally
        {
            output?.Dispose();
            if (unicodeAddress != IntPtr.Zero) Marshal.FreeHGlobal(unicodeAddress);
            if (nameBuffer != IntPtr.Zero) Marshal.FreeHGlobal(nameBuffer);
            if (addedReference) admittedDirectory.DangerousRelease();
            CryptographicOperations.ZeroMemory(record);
        }
    }
}
