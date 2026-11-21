using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace ConsoleMcp.Sealer.Service;

// Security admission of an already-open key *file object*. Does not read,
// generate or return a secret. An independent fixed-root opener must verify
// file provenance and parents before a privileged service may read this file.
public static class SealAuthorityKeyHandleAdmission
{
    private const uint SeFileObject = 1;
    private const uint OwnerSecurityInformation = 1;
    private const uint DaclSecurityInformation = 4;
    private const uint ReparsePoint = 0x400;
    private const uint Directory = 0x10;

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    private struct ByHandleFileInformation
    {
        public uint Attributes;
        public long Created, Accessed, Written;
        public uint VolumeSerial;
        public uint SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle,
        out ByHandleFileInformation info);

    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern uint GetSecurityInfo(SafeFileHandle handle, uint objectType,
        uint securityInfo, out IntPtr owner, IntPtr group, out IntPtr dacl,
        IntPtr sacl, out IntPtr descriptor);

    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);

    [DllImport("kernel32.dll", ExactSpelling = true)]
    private static extern IntPtr LocalFree(IntPtr memory);

    // Public only for disposable regression. The privileged entrypoint must
    // pass the literal S-1-5-18, not an identity from the incoming envelope.
    public static bool Verify(SafeFileHandle keyFile, string expectedOwnerSid)
    {
        if (!OperatingSystem.IsWindows() || keyFile is null ||
            keyFile.IsInvalid || keyFile.IsClosed)
            return false;
        try
        {
            var sid = new SecurityIdentifier(expectedOwnerSid);
            if (!sid.IsAccountSid() && sid.Value != "S-1-5-18")
                return false;
            if (!GetFileInformationByHandle(keyFile, out var info) ||
                (info.Attributes & (ReparsePoint | Directory)) != 0 ||
                info.SizeHigh != 0 || info.SizeLow != 32 || info.Links != 1)
                return false;
            IntPtr descriptor = IntPtr.Zero;
            try
            {
                uint result = GetSecurityInfo(keyFile, SeFileObject,
                    OwnerSecurityInformation | DaclSecurityInformation,
                    out _, IntPtr.Zero, out _, IntPtr.Zero, out descriptor);
                if (result != 0 || descriptor == IntPtr.Zero)
                    return false;
                uint length = GetSecurityDescriptorLength(descriptor);
                if (length == 0 || length > 65536)
                    return false;
                byte[] bytes = new byte[checked((int)length)];
                Marshal.Copy(descriptor, bytes, 0, bytes.Length);
                var acl = new RawSecurityDescriptor(bytes, 0);
                if (acl.Owner?.Value != sid.Value ||
                    (acl.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0 ||
                    acl.DiscretionaryAcl?.Count != 1 ||
                    acl.DiscretionaryAcl[0] is not CommonAce ace ||
                    ace.AceType != AceType.AccessAllowed ||
                    ace.AceFlags != AceFlags.None ||
                    ace.SecurityIdentifier.Value != sid.Value ||
                    (ace.AccessMask & (int)FileSystemRights.FullControl) !=
                    (int)FileSystemRights.FullControl)
                    return false;
                return true;
            }
            finally
            {
                if (descriptor != IntPtr.Zero) _ = LocalFree(descriptor);
            }
        }
        catch (Exception error) when (error is ArgumentException or IOException or
            OverflowException or UnauthorizedAccessException or
            ObjectDisposedException or System.Security.SecurityException)
        {
            return false;
        }
    }
}
