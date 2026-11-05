using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace ConsoleMcp.Sealer.Service;

// Read-only attestation of a fixed three-directory chain using handles that
// remain open through verification. No production open/provisioning path.
// Each handle must already be opened with FILE_READ_ATTRIBUTES|READ_CONTROL,
// OPEN_REPARSE_POINT and no delete sharing by its trusted caller.
public static class SealReplayHandleChainAdmission
{
    private const uint FileNameNormalized = 0;
    private const uint VolumeNameDos = 0;
    private const uint FileAttributeDirectory = 0x10;
    private const uint FileAttributeReparsePoint = 0x400;

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    private struct ByHandleInfo
    {
        public uint Attributes;
        public long CreationTime;
        public long AccessTime;
        public long WriteTime;
        public uint Volume;
        public uint SizeHigh;
        public uint SizeLow;
        public uint Links;
        public uint IndexHigh;
        public uint IndexLow;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out ByHandleInfo info);

    [DllImport("kernel32.dll", EntryPoint = "GetFinalPathNameByHandleW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);

    private static string? FinalPath(SafeFileHandle handle)
    {
        var buffer = new StringBuilder(1024);
        uint count = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, FileNameNormalized | VolumeNameDos);
        if (count == 0 || count >= buffer.Capacity)
            return null;
        string value = buffer.ToString();
        if (!value.StartsWith(@"\\?\", StringComparison.Ordinal))
            return null;
        return value[4..].TrimEnd('\\');
    }

    // Rejects aliases and unexpected path ancestry. Not a guarantee against
    // hard links, parent renames after attestation or physical power loss.
    public static bool Verify(
        SafeFileHandle managedRoot, SafeFileHandle authorityRoot, SafeFileHandle journalRoot,
        string canonicalManagedPath, string expectedOwnerSid)
    {
        if (!OperatingSystem.IsWindows() ||
            string.IsNullOrWhiteSpace(canonicalManagedPath) ||
            new[] { managedRoot, authorityRoot, journalRoot }.Any(h => h is null || h.IsInvalid || h.IsClosed))
            return false;

        try
        {
            string expectedManaged = Path.GetFullPath(canonicalManagedPath).TrimEnd('\\');
            if (!Path.IsPathFullyQualified(expectedManaged))
                return false;
            string expectedAuthority = Path.Combine(expectedManaged, "seal-authority");
            string expectedJournal = Path.Combine(expectedAuthority, "replay-journal");
            SafeFileHandle[] handles = [managedRoot, authorityRoot, journalRoot];
            string[] expectedPaths = [expectedManaged, expectedAuthority, expectedJournal];
            var identities = new HashSet<(uint Volume, ulong FileIndex)>();

            for (int i = 0; i < handles.Length; i++)
            {
                if (!SealReplayDirectoryHandleAdmission.Verify(handles[i], expectedOwnerSid) ||
                    !GetFileInformationByHandle(handles[i], out ByHandleInfo info) ||
                    (info.Attributes & FileAttributeDirectory) == 0 ||
                    (info.Attributes & FileAttributeReparsePoint) != 0)
                    return false;
                ulong index = ((ulong)info.IndexHigh << 32) | info.IndexLow;
                if (!identities.Add((info.Volume, index)))
                    return false;
                string? actual = FinalPath(handles[i]);
                if (actual is null ||
                    !string.Equals(actual, expectedPaths[i], StringComparison.OrdinalIgnoreCase))
                    return false;
            }
            return true;
        }
        catch (Exception error) when (error is ArgumentException or IOException or UnauthorizedAccessException or
            ObjectDisposedException or System.Security.SecurityException)
        {
            return false;
        }
    }
}
