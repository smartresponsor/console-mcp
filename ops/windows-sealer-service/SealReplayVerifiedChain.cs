using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace ConsoleMcp.Sealer.Service;

// Holds all three independently verified directory handles until disposed.
// Read-only admission; it never creates claims or grants seal authorization.
// The general path overload is internal and may only be used by native fixture
// regression; production entry point always starts at the SYSTEM-only root.
internal sealed class SealReplayVerifiedChain : IDisposable
{
    private SafeFileHandle? _root;
    private SafeFileHandle? _authority;
    private SafeFileHandle? _journal;
    private bool _disposed;

    private SealReplayVerifiedChain(SafeFileHandle root, SafeFileHandle authority, SafeFileHandle journal)
    {
        _root = root;
        _authority = authority;
        _journal = journal;
    }

    internal bool IsOpen => !_disposed &&
        _root is { IsClosed: false, IsInvalid: false } &&
        _authority is { IsClosed: false, IsInvalid: false } &&
        _journal is { IsClosed: false, IsInvalid: false };

    // Do not expose a mutable raw handle to broker-facing code.
    // This object is intentionally NOT connected to SealReplayHandleClaim.
    internal bool VerifyAgain(string expectedRoot, string expectedOwnerSid) =>
        IsOpen && SealReplayHandleChainAdmission.Verify(
            _root!, _authority!, _journal!, expectedRoot, expectedOwnerSid);

    internal static SealReplayVerifiedChain? OpenForSystem()
    {
        if (!OperatingSystem.IsWindows())
            return null;
        using WindowsIdentity token = WindowsIdentity.GetCurrent();
        if (token.User?.Value != "S-1-5-18" ||
            System.Diagnostics.Process.GetCurrentProcess().SessionId != 0)
            return null;
        SafeFileHandle? root = SealReplayTrustedRootOpen.Open();
        if (root is null)
            return null;
        // The root opener itself has already attested the opened root object.
        return OpenFromAttestedRoot(root,
            SealReplayTrustedRootOpen.ManagedRoot, "S-1-5-18");
    }

    // Requires an already-attested root; no privilege elevation or write path.
    // Fixture invokes this with disposable user-owned directories only.
    internal static SealReplayVerifiedChain? OpenFromAttestedRoot(
        SafeFileHandle ownedRoot, string expectedRoot, string expectedOwnerSid)
    {
        SafeFileHandle? root = ownedRoot;
        SafeFileHandle? authority = null;
        SafeFileHandle? journal = null;
        try
        {
            if (root is null || root.IsInvalid || root.IsClosed ||
                !SealReplayDirectoryHandleAdmission.Verify(root, expectedOwnerSid))
                return null;
            authority = SealReplayRelativeDirectoryOpen.OpenChild(root, "seal-authority");
            if (authority is null ||
                !SealReplayDirectoryHandleAdmission.Verify(authority, expectedOwnerSid))
                return null;
            journal = SealReplayRelativeDirectoryOpen.OpenChild(authority, "replay-journal");
            if (journal is null ||
                !SealReplayHandleChainAdmission.Verify(root, authority, journal,
                    expectedRoot, expectedOwnerSid))
                return null;
            var chain = new SealReplayVerifiedChain(root, authority, journal);
            root = null;
            authority = null;
            journal = null;
            return chain;
        }
        catch (Exception error) when (error is IOException or ArgumentException or
               UnauthorizedAccessException or ObjectDisposedException or
               System.Security.SecurityException)
        {
            return null;
        }
        finally
        {
            // Fail closed: ownership transferred to the lease on success.
            journal?.Dispose();
            authority?.Dispose();
            root?.Dispose();
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _journal?.Dispose();
        _authority?.Dispose();
        _root?.Dispose();
        _journal = null;
        _authority = null;
        _root = null;
    }
}
