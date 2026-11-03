using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ConsoleMcp.Sealer.Service;

DateTimeOffset now = new(2026, 11, 3, 14, 0, 0, TimeSpan.Zero);
byte[] key = Enumerable.Range(0, 32).Select(i => (byte)i).ToArray();
var request = new Dictionary<string, object>
{
    ["schema_version"] = 1,
    ["operation"] = "seal_new_release",
    ["request_id"] = new string('a', 32),
    ["source_sha"] = new string('b', 40),
    ["payload_inventory_sha256"] = new string('c', 64),
    ["release_id"] = new string('d', 40),
    ["rollback_release_id"] = new string('e', 40),
    ["expires_at"] = now.AddMinutes(5).ToString("O")
};
string[] canonicalFields = [
    "schema_version", "operation", "request_id", "source_sha",
    "payload_inventory_sha256", "release_id", "rollback_release_id", "expires_at"
];
var canonical = new StringBuilder("console-mcp-seal-request-v1\n");
foreach (string name in canonicalFields)
{
    string value = request[name].ToString()!;
    canonical.Append(Encoding.UTF8.GetByteCount(name)).Append(':').Append(name)
        .Append(':').Append(Encoding.UTF8.GetByteCount(value)).Append(':')
        .Append(value).Append('\n');
}
request["authority_mac"] = Convert.ToHexString(HMACSHA256.HashData(key,
    Encoding.UTF8.GetBytes(canonical.ToString()))).ToLowerInvariant();
byte[] Encode(Dictionary<string, object> value) => JsonSerializer.SerializeToUtf8Bytes(value);
void Require(bool ok, string name)
{
    if (!ok) throw new Exception("RELEASE_SEAL_REQUEST_REGRESSION_FAILED: " + name);
}
Require(SealRequestAdmission.Verify(Encode(request), key, now), "valid_hmac");
Require(!SealRequestAdmission.Verify(Encode(request), new byte[31], now), "weak_key");
Require(!SealRequestAdmission.Verify(new byte[4097], key, now), "oversized_frame");
Require(!SealRequestAdmission.Verify(Encoding.UTF8.GetBytes("{\"schema_version\":1,\"schema_version\":1}"), key, now), "duplicate_key");
Require(!SealRequestAdmission.Verify(Encoding.UTF8.GetBytes("[]"), key, now), "non_object");
void Negative(string field, object value, string name)
{
    object old = request[field];
    request[field] = value;
    Require(!SealRequestAdmission.Verify(Encode(request), key, now), name);
    request[field] = old;
}
Negative("source_sha", new string('f',40), "tamper_source");
Negative("request_id", new string('A',32), "uppercase_id");
Negative("operation", "ping", "operation");
Negative("release_id", new string('e',40), "self_rollback");
Negative("expires_at", now.AddMinutes(-1).ToString("O"), "expired");
Negative("expires_at", now.AddMinutes(11).ToString("O"), "future_unbounded");
Negative("expires_at", "11/03/2026 14:05", "locale_timestamp");
Negative("schema_version", 2, "schema_version");
request["extra"] = "unexpected";
Require(!SealRequestAdmission.Verify(Encode(request), key, now), "extra_field");
request.Remove("extra");
Console.WriteLine("RELEASE_SEALER_CSHARP_REQUEST_REGRESSION_PASS");
