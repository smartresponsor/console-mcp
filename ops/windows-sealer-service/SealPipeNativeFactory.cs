using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;

namespace ConsoleMcp.Sealer.Service;

// A privileged, single-instance pipe factory. Not called by the live SCM
// service until key custody, replay and source gates are implemented.
public static class SealPipeNativeFactory
{
    public const string PipeName = "ConsoleMcpReleaseSealerV3";

    public static NamedPipeServerStream Create(string protectedBrokerSid)
    {
        if (!OperatingSystem.IsWindows())
            throw new InvalidOperationException("RELEASE_SEAL_PIPE_WINDOWS_REQUIRED");

        using WindowsIdentity identity = WindowsIdentity.GetCurrent();
        if (identity.User?.Value != "S-1-5-18" ||
            System.Diagnostics.Process.GetCurrentProcess().SessionId != 0)
            throw new UnauthorizedAccessException("RELEASE_SEAL_PIPE_SYSTEM_SESSION_REQUIRED");

        string sddl = SealPipeSecurityPolicy.Build(protectedBrokerSid);
        SealPipeSecurityPolicy.Verify(sddl, protectedBrokerSid);
        var security = new PipeSecurity();
        security.SetSecurityDescriptorSddlForm(sddl);

        // Do not pass CurrentUserOnly: .NET would silently ignore the given
        // PipeSecurity and replace it with its own single-user ACL.
        return NamedPipeServerStreamAcl.Create(
            PipeName,
            PipeDirection.InOut,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous,
            SealRequestAdmission.MaxFrameBytes,
            SealRequestAdmission.MaxFrameBytes,
            security,
            HandleInheritability.None,
            PipeAccessRights.ChangePermissions);
    }
}
