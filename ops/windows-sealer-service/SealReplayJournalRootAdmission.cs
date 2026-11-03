using System.Security.AccessControl;
using System.Security.Principal;

namespace ConsoleMcp.Sealer.Service;

// Read-only security preflight. This is NOT an atomic authorization for a
// future write: directory handles and open-by-handle checks remain necessary
// to prevent path swaps between preflight and the actual claim operation.
public static class SealReplayJournalRootAdmission
{
    public const string JournalRoot = @"C:\ProgramData\ConsoleMcp\seal-authority\replay-journal";
    private const string ManagedRoot = @"C:\ProgramData\ConsoleMcp";
    private const string SystemSid = "S-1-5-18";
    private const int MutatingRights = (int)(
        FileSystemRights.Write | FileSystemRights.Delete |
        FileSystemRights.DeleteSubdirectoriesAndFiles |
        FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership);

    public static bool Check(string path)
    {
        if (!OperatingSystem.IsWindows() || string.IsNullOrWhiteSpace(path))
            return false;

        try
        {
            using WindowsIdentity identity = WindowsIdentity.GetCurrent();
            if (identity.User?.Value != SystemSid ||
                System.Diagnostics.Process.GetCurrentProcess().SessionId != 0)
                return false;

            string root = Path.GetFullPath(JournalRoot);
            string managedRoot = Path.GetFullPath(ManagedRoot);
            if (!string.Equals(Path.GetFullPath(path), root, StringComparison.OrdinalIgnoreCase))
                return false;

            string current = root;
            while (true)
            {
                DirectoryInfo entry = new(current);
                entry.Refresh();
                if (!entry.Exists || entry.LinkTarget is not null ||
                    (entry.Attributes & FileAttributes.ReparsePoint) != 0)
                    return false;
                DirectorySecurity acl = FileSystemAclExtensions.GetAccessControl(entry);
                if (acl.GetOwner(typeof(SecurityIdentifier)) is not SecurityIdentifier owner ||
                    owner.Value != SystemSid || !acl.AreAccessRulesProtected)
                    return false;

                AuthorizationRuleCollection rules = acl.GetAccessRules(true, false, typeof(SecurityIdentifier));
                bool fullSystemControl = false;
                foreach (FileSystemAccessRule rule in rules)
                {
                    if (rule.AccessControlType != AccessControlType.Allow ||
                        rule.IdentityReference is not SecurityIdentifier sid)
                        return false;
                    if (sid.Value == SystemSid)
                    {
                        fullSystemControl |= (rule.FileSystemRights & FileSystemRights.FullControl)
                            == FileSystemRights.FullControl;
                    }
                    else if (current == root ||
                             ((int)rule.FileSystemRights & MutatingRights) != 0)
                    {
                        return false;
                    }
                }
                if (!fullSystemControl)
                    return false;
                if (string.Equals(current, managedRoot, StringComparison.OrdinalIgnoreCase))
                    return true;
                string? parent = Path.GetDirectoryName(current);
                if (parent is null || parent.Length < managedRoot.Length ||
                    !parent.StartsWith(managedRoot + Path.DirectorySeparatorChar,
                        StringComparison.OrdinalIgnoreCase) &&
                    !string.Equals(parent, managedRoot, StringComparison.OrdinalIgnoreCase))
                    return false;
                current = parent;
            }
        }
        catch (Exception error) when (error is IOException or ArgumentException or
            UnauthorizedAccessException or System.Security.SecurityException or
            InvalidOperationException)
        {
            return false;
        }
    }
}
