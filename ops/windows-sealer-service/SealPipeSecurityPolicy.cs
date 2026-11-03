using System.Security.AccessControl;
using System.Security.Principal;

namespace ConsoleMcp.Sealer.Service;

// Pure SDDL policy for a future LocalSystem-owned, broker-only pipe.
// This does not bind any pipe, provision broker identity or authorize a seal.
public static class SealPipeSecurityPolicy
{
    private const string LocalSystem = "S-1-5-18";
    // FILE_GENERIC_READ | FILE_GENERIC_WRITE, but exclude bit 0x4:
    // on a named-pipe object FILE_APPEND_DATA aliases FILE_CREATE_PIPE_INSTANCE.
    // Broker may connect and exchange bytes but may not create pipe instances.
    public const int BrokerAccessMask = 0x0012019B;
    public const int OwnerAccessMask = 0x001F01FF;

    public static string Build(string brokerSid)
    {
        if (!OperatingSystem.IsWindows() || string.IsNullOrWhiteSpace(brokerSid))
            throw new ArgumentException("RELEASE_SEAL_PIPE_BROKER_SID_REQUIRED", nameof(brokerSid));

        var broker = new SecurityIdentifier(brokerSid);
        if (!broker.IsAccountSid() || broker.Value == LocalSystem || broker.Value == "S-1-5-7")
            throw new ArgumentException("RELEASE_SEAL_PIPE_BROKER_ACCOUNT_INVALID", nameof(brokerSid));

        string sddl = $"O:SYG:SYD:P(A;;0x{OwnerAccessMask:X8};;;SY)(A;;0x{BrokerAccessMask:X8};;;{broker.Value})";
        Verify(sddl, broker.Value);
        return sddl;
    }

    public static void Verify(string sddl, string brokerSid)
    {
        if (!OperatingSystem.IsWindows())
            throw new InvalidOperationException("RELEASE_SEAL_PIPE_WINDOWS_REQUIRED");

        var descriptor = new RawSecurityDescriptor(sddl);
        if (descriptor.Owner?.Value != LocalSystem ||
            descriptor.Group?.Value != LocalSystem ||
            (descriptor.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0 ||
            descriptor.DiscretionaryAcl is null ||
            descriptor.DiscretionaryAcl.Count != 2)
            throw new InvalidOperationException("RELEASE_SEAL_PIPE_ACL_INVALID");

        var owner = descriptor.DiscretionaryAcl[0] as CommonAce;
        var broker = descriptor.DiscretionaryAcl[1] as CommonAce;
        if (owner is null || broker is null ||
            owner.AceType != AceType.AccessAllowed ||
            broker.AceType != AceType.AccessAllowed ||
            owner.SecurityIdentifier.Value != LocalSystem ||
            broker.SecurityIdentifier.Value != brokerSid ||
            owner.AccessMask != OwnerAccessMask ||
            broker.AccessMask != BrokerAccessMask ||
            (broker.AccessMask & 0x4) != 0 ||
            owner.AceFlags != AceFlags.None ||
            broker.AceFlags != AceFlags.None)
            throw new InvalidOperationException("RELEASE_SEAL_PIPE_ACL_INVALID");
    }
}
