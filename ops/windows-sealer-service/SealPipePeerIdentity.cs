using System.IO.Pipes;
using System.Security.Principal;

namespace ConsoleMcp.Sealer.Service;

// The expected broker SID must originate in a protected service configuration.
// It must never arrive from the untrusted pipe payload. No listener is opened.
public static class SealPipePeerIdentity
{
    public static bool Matches(NamedPipeServerStream pipe, string expectedBrokerSid)
    {
        if (!OperatingSystem.IsWindows() ||
            pipe is null ||
            !pipe.IsConnected ||
            string.IsNullOrWhiteSpace(expectedBrokerSid))
            return false;
        try
        {
            var expected = new SecurityIdentifier(expectedBrokerSid);
            if (expected.Value is "S-1-5-18" or "S-1-5-7" ||
                !expected.IsAccountSid())
                return false;

            string? observed = null;
            pipe.RunAsClient(() =>
            {
                // Explicit true disallows falling back to the host token.
                using WindowsIdentity? client = WindowsIdentity.GetCurrent(ifImpersonating: true);
                observed = client?.User?.Value;
            });
            return string.Equals(observed, expected.Value, StringComparison.Ordinal);
        }
        catch (Exception error) when (error is IOException or
               InvalidOperationException or UnauthorizedAccessException or
               System.Security.SecurityException or ArgumentException)
        {
            return false;
        }
    }
}
