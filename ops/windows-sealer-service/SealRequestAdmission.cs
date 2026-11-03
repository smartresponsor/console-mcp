using System.Buffers;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ConsoleMcp.Sealer.Service;

// Pure, bounded admission primitive. Does not load keys, bind a pipe,
// read/write a journal, inspect source files or authorize a seal.
public static class SealRequestAdmission
{
    public const int MaxFrameBytes = 4096;
    private const string Domain = "console-mcp-seal-request-v1\n";
    private static readonly string[] Names =
    [
        "schema_version", "operation", "request_id", "source_sha",
        "payload_inventory_sha256", "release_id", "rollback_release_id",
        "expires_at", "authority_mac"
    ];

    private static readonly HashSet<string> AllNames = new(Names, StringComparer.Ordinal);

    public static bool Verify(ReadOnlySpan<byte> json, ReadOnlySpan<byte> secret, DateTimeOffset now)
    {
        if (secret.Length != 32 || json.IsEmpty || json.Length > MaxFrameBytes)
            return false;
        try
        {
            using JsonDocument document = JsonDocument.Parse(json.ToArray(), new JsonDocumentOptions
            {
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = 4
            });
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                return false;
            var fields = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (JsonProperty property in root.EnumerateObject())
            {
                if (!AllNames.Contains(property.Name) || !fields.TryAdd(property.Name, string.Empty))
                    return false;
                if (property.Name == "schema_version")
                {
                    if (property.Value.ValueKind != JsonValueKind.Number ||
                        !property.Value.TryGetInt32(out int version) || version != 1)
                        return false;
                    fields[property.Name] = "1";
                }
                else
                {
                    if (property.Value.ValueKind != JsonValueKind.String)
                        return false;
                    fields[property.Name] = property.Value.GetString() ?? string.Empty;
                }
            }
            if (fields.Count != Names.Length || fields["operation"] != "seal_new_release")
                return false;
            if (!IsLowerHex(fields["request_id"], 32) ||
                !IsLowerHex(fields["source_sha"], 40) ||
                !IsLowerHex(fields["payload_inventory_sha256"], 64) ||
                !IsLowerHex(fields["release_id"], 40) ||
                !IsLowerHex(fields["rollback_release_id"], 40) ||
                !IsLowerHex(fields["authority_mac"], 64) ||
                fields["release_id"] == fields["rollback_release_id"])
                return false;

            // UTC/offset ISO-8601 only; never accept locale-dependent timestamps.
            string expiry = fields["expires_at"];
            if (!Regex.IsMatch(expiry, @"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$", RegexOptions.CultureInvariant) ||
                !DateTimeOffset.TryParse(expiry, CultureInfo.InvariantCulture, DateTimeStyles.None, out DateTimeOffset expires) ||
                expires <= now || expires > now.AddMinutes(10))
                return false;

            var canonical = new StringBuilder(Domain);
            foreach (string name in Names[..^1])
            {
                string value = fields[name];
                if (value.Any(ch => char.IsControl(ch)))
                    return false;
                canonical.Append(Encoding.UTF8.GetByteCount(name)).Append(':').Append(name)
                    .Append(':').Append(Encoding.UTF8.GetByteCount(value)).Append(':')
                    .Append(value).Append('\n');
            }
            byte[] expected = HMACSHA256.HashData(secret, Encoding.UTF8.GetBytes(canonical.ToString()));
            byte[] supplied = Convert.FromHexString(fields["authority_mac"]);
            return CryptographicOperations.FixedTimeEquals(expected, supplied);
        }
        catch (Exception ex) when (ex is JsonException or ArgumentException or FormatException or OverflowException)
        {
            return false;
        }
    }

    private static bool IsLowerHex(string value, int length) =>
        value.Length == length && value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
}
