using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace ConsoleMcp.Sealer.Service;

// Verifies attributes and security of the *opened directory object*, not a
// pathname. Caller must separately attest the ancestry and canonical root
// when opening this handle. This does not itself authorize release sealing.
public static class SealReplayDirectoryHandleAdmission
{
    private const uint SeFileObject = 1;
    private const uint OwnerSecurityInformation = 1;
    private const uint DaclSecurityInformation = 4;
    private const uint FileAttributeDirectory = 0x10;
    private const uint FileAttributeReparsePoint = 0x400;
    private const uint FileAttributeReadOnly = 0x1;

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    private struct ByHandleFileInformation
    {
        public uint FileAttributes;
        public long CreationTime;
        public long LastAccessTime;
        public long LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle,
        out ByHandleFileInformation info);

    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern uint GetSecurityInfo(SafeFileHandle handle,
        uint objectType, uint securityInfo, out IntPtr owner, IntPtr group,
        out IntPtr dacl, IntPtr sacl, out IntPtr securityDescriptor);

    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern uint GetSecurityDescriptorLength(IntPtr securityDescriptor);

    [DllImport("kernel32.dll", ExactSpelling = true)]
    private static extern IntPtr LocalFree(IntPtr memory);

    // For a SYSTEM journal, pass S-1-5-18. A test caller may validate
    // a disposable directory with their own account SID.
    public static bool Verify(SafeFileHandle directory, string expectedOwnerSid)
    {
        if (!OperatingSystem.IsWindows() || directory is null ||
            directory.IsInvalid || directory.IsClosed)
            return false;

        try
        {
            var expected = new SecurityIdentifier(expectedOwnerSid);
            if (!expected.IsAccountSid() && expected.Value != "S-1-5-18")
                return false;
            if (!GetFileInformationByHandle(directory, out ByHandleFileInformation info))
                return false;
            if ((info.FileAttributes & FileAttributeDirectory) == 0 ||
                (info.FileAttributes & (FileAttributeReparsePoint | FileAttributeReadOnly)) != 0)
                return false;

            IntPtr securityDescriptor = IntPtr.Zero;
            try
            {
                uint result = GetSecurityInfo(directory, SeFileObject,
                    OwnerSecurityInformation | DaclSecurityInformation,
                    out _, IntPtr.Zero, out _, IntPtr.Zero, out securityDescriptor);
                if (result != 0 || securityDescriptor == IntPtr.Zero)
                    return false;
                uint length = GetSecurityDescriptorLength(securityDescriptor);
                if (length == 0 || length > 65536)
                    return false;
                byte[] bytes = new byte[checked((int)length)];
                Marshal.Copy(securityDescriptor, bytes, 0, bytes.Length);
                var descriptor = new RawSecurityDescriptor(bytes, 0);
                if (descriptor.Owner?.Value != expected.Value ||
                    (descriptor.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0 ||
                    descriptor.DiscretionaryAcl is null ||
                    descriptor.DiscretionaryAcl.Count != 1)
                    return false;
                if (descriptor.DiscretionaryAcl[0] is not CommonAce ace ||
                    ace.AceType != AceType.AccessAllowed ||
                    (ace.AceFlags & ~(AceFlags.ContainerInherit | AceFlags.ObjectInherit)) != AceFlags.None ||
                    ace.SecurityIdentifier.Value != expected.Value ||
                    (ace.AccessMask & (int)FileSystemRights.FullControl) != (int)FileSystemRights.FullControl)
                    return false;
                return true;
            }
            finally
            {
                if (securityDescriptor != IntPtr.Zero)
                    _ = LocalFree(securityDescriptor);
            }
        }
        catch (Exception exception) when (exception is ArgumentException or
            UnauthorizedAccessException or System.Security.SecurityException or
            OverflowException or ObjectDisposedException)
        {
            return false;
        }
    }
}
