using System.Security.AccessControl;
using System.Security.Principal;

namespace ConsoleMcp.Sealer.Service;

// Admission only: this function MUST run in the real SYSTEM service process.
// It never generates, loads, copies or returns secret material.
// Owner and write authority are checked on the authority file AND every
// managed ancestor down to the fixed, protected seal-authority root.
public static class SealAuthorityFileAdmission
{
    public const string AuthorityRoot = @"C:\ProgramData\ConsoleMcp\seal-authority";
    private const string ManagedRoot = @"C:\ProgramData\ConsoleMcp";
    private const string SystemSid = "S-1-5-18";
    private const int MutatingRights =
        (int)(FileSystemRights.Write | FileSystemRights.Delete |
              FileSystemRights.DeleteSubdirectoriesAndFiles |
              FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership);

    public static bool Check(string absolutePath)
    {
        if (!OperatingSystem.IsWindows())
            return false;
        try
        {
            using WindowsIdentity token = WindowsIdentity.GetCurrent();
            if (token.User?.Value != SystemSid ||
                System.Diagnostics.Process.GetCurrentProcess().SessionId != 0)
                return false;

            string root = Path.GetFullPath(AuthorityRoot);
            string managedRoot = Path.GetFullPath(ManagedRoot);
            string file = Path.GetFullPath(absolutePath);
            if (!file.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(Path.GetFileName(file), "broker-hmac.key", StringComparison.Ordinal))
                return false;
            var info = new FileInfo(file);
            if (!info.Exists || info.LinkTarget is not null || info.Length != 32)
                return false;

            string? current = file;
            while (current is not null)
            {
                FileSystemInfo entry = current == file ? new FileInfo(current) : new DirectoryInfo(current);
                entry.Refresh();
                if (!entry.Exists || entry.LinkTarget is not null ||
                    (entry.Attributes & FileAttributes.ReparsePoint) != 0)
                    return false;

                FileSystemSecurity acl = entry is FileInfo
                    ? FileSystemAclExtensions.GetAccessControl((FileInfo)entry)
                    : FileSystemAclExtensions.GetAccessControl((DirectoryInfo)entry);
                if (acl.GetOwner(typeof(SecurityIdentifier)) is not SecurityIdentifier owner ||
                    owner.Value != SystemSid ||
                    !acl.AreAccessRulesProtected)
                    return false;

                AuthorizationRuleCollection rules = acl.GetAccessRules(true, false, typeof(SecurityIdentifier));
                bool hasSystemFullControl = false;
                foreach (FileSystemAccessRule rule in rules)
                {
                    if (rule.AccessControlType != AccessControlType.Allow ||
                        rule.IdentityReference is not SecurityIdentifier sid)
                        return false;
                    if (sid.Value == SystemSid)
                    {
                        hasSystemFullControl |=
                            (rule.FileSystemRights & FileSystemRights.FullControl) == FileSystemRights.FullControl;
                    }
                    else
                    {
                        // The broker account, administrators, users and ANY
                        // other SID must not receive file write/delete/ACL rights.
                        if (((int)rule.FileSystemRights & MutatingRights) != 0)
                            return false;
                        if (current == file)
                            return false; // the raw HMAC key is SYSTEM-only
                    }
                }
                if (!hasSystemFullControl)
                    return false;
                if (string.Equals(current, managedRoot, StringComparison.OrdinalIgnoreCase))
                    return true;
                current = Path.GetDirectoryName(current);
                if (current is null ||
                    current.Length < managedRoot.Length ||
                    !current.StartsWith(managedRoot, StringComparison.OrdinalIgnoreCase))
                    return false;
            }
        }
        catch (Exception error) when (error is IOException or
               UnauthorizedAccessException or ArgumentException or
               System.Security.SecurityException or InvalidOperationException)
        {
            return false;
        }
        return false;
    }
}
