using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace ConsoleMcp.Sealer.Service;

// Crash-safe, append-only *claim* primitive in a caller-supplied fixture root.
// This class neither grants seal authorization nor vouches for the root ACL.
// Production callers must first prove SYSTEM-only owner, protected ancestry,
// non-reparse paths and durable rollback/source verification.
public static class SealReplayJournal
{
    private static readonly Regex RequestIdPattern = new(
        "^[0-9a-f]{32}$", RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);
    private static readonly byte[] RecordMagic = Encoding.ASCII.GetBytes("console-mcp-replay-v1\n");

    public static bool TryClaim(string directory, string requestId)
    {
        if (string.IsNullOrWhiteSpace(directory) ||
            requestId is null || !RequestIdPattern.IsMatch(requestId))
            return false;

        string root = Path.GetFullPath(directory);
        // Never create the directory: caller must independently attest a
        // pre-existing protected root before invoking this primitive.
        if (!Directory.Exists(root))
            return false;

        string file = Path.Combine(root, requestId + ".claim");
        var data = new byte[RecordMagic.Length + requestId.Length + 1];
        RecordMagic.CopyTo(data, 0);
        Encoding.ASCII.GetBytes(requestId).CopyTo(data, RecordMagic.Length);
        data[^1] = (byte)'\n';

        try
        {
            using (var stream = new FileStream(file, FileMode.CreateNew,
                FileAccess.Write, FileShare.None, 4096,
                FileOptions.WriteThrough | FileOptions.SequentialScan))
            {
                stream.Write(data);
                stream.Flush(flushToDisk: true);
            }
            // No deletion on IO failure: a partially created claim still
            // prevents replay until an independent recovery/attestation gate.
            return true;
        }
        catch (IOException)
        {
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            return false;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(data);
        }
    }

    // Read-only evidence, not an authority to clear or retry a claim.
    // Treat corrupt, truncated or mismatched records as *claimed*.
    public static bool IsClaimed(string directory, string requestId)
    {
        if (string.IsNullOrWhiteSpace(directory) ||
            requestId is null || !RequestIdPattern.IsMatch(requestId))
            return true;
        try
        {
            return File.Exists(Path.Combine(Path.GetFullPath(directory), requestId + ".claim"));
        }
        catch (Exception error) when (error is IOException or ArgumentException or UnauthorizedAccessException)
        {
            return true;
        }
    }
}
