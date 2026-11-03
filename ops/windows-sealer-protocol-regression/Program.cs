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

// Transport framing is not an authorization signal: valid data only yields a
// parseable frame; the only response allowed here is explicit denial.
byte[] payload = Encode(request);
byte[] framed = new byte[4 + payload.Length];
System.Buffers.Binary.BinaryPrimitives.WriteUInt32LittleEndian(framed, (uint)payload.Length);
payload.CopyTo(framed, 4);
byte[]? decoded = await SealPipeFrame.ReadAsync(new MemoryStream(framed));
Require(decoded is not null && decoded.SequenceEqual(payload), "valid_frame");
byte[] tooLarge = new byte[4];
System.Buffers.Binary.BinaryPrimitives.WriteUInt32LittleEndian(tooLarge, 4097);
Require(await SealPipeFrame.ReadAsync(new MemoryStream(tooLarge)) is null, "oversized_length");
Require(await SealPipeFrame.ReadAsync(new MemoryStream(new byte[4])) is null, "empty_length");
Require(await SealPipeFrame.ReadAsync(new MemoryStream(new byte[2])) is null, "truncated_header");
Require(await SealPipeFrame.ReadAsync(new MemoryStream(framed[..^1])) is null, "truncated_body");
using var refused = new MemoryStream();
await SealPipeFrame.WriteDeniedAsync(refused);
Require(refused.ToArray().SequenceEqual(new byte[] { 0x01 }), "deny_only_response");
Console.WriteLine("RELEASE_SEALER_CSHARP_FRAME_REGRESSION_PASS");

using (var disconnected = new System.IO.Pipes.NamedPipeServerStream(
    "console-mcp-seal-disconnected-" + Guid.NewGuid().ToString("N"),
    System.IO.Pipes.PipeDirection.InOut, 1, System.IO.Pipes.PipeTransmissionMode.Byte,
    System.IO.Pipes.PipeOptions.Asynchronous | System.IO.Pipes.PipeOptions.CurrentUserOnly))
{
    Require(!SealPipePeerIdentity.Matches(disconnected, "S-1-5-18"), "disconnected_system");
}
string pipeName = "console-mcp-seal-identity-fixture-" + Guid.NewGuid().ToString("N");
using (var server = new System.IO.Pipes.NamedPipeServerStream(
    pipeName, System.IO.Pipes.PipeDirection.InOut, 1,
    System.IO.Pipes.PipeTransmissionMode.Byte,
    System.IO.Pipes.PipeOptions.Asynchronous | System.IO.Pipes.PipeOptions.CurrentUserOnly))
using (var client = new System.IO.Pipes.NamedPipeClientStream(
    ".", pipeName, System.IO.Pipes.PipeDirection.InOut,
    System.IO.Pipes.PipeOptions.Asynchronous,
    System.Security.Principal.TokenImpersonationLevel.Impersonation))
using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5)))
{
    var waiting = server.WaitForConnectionAsync(timeout.Token);
    await client.ConnectAsync(timeout.Token);
    await waiting;
    byte[] signal = new byte[1];
    Task<int> receiving = server.ReadAsync(signal, timeout.Token).AsTask();
    await client.WriteAsync(new byte[] { 0x2A }, timeout.Token);
    await client.FlushAsync(timeout.Token);
    Require(await receiving == 1, "client_signal");
    string me = System.Security.Principal.WindowsIdentity.GetCurrent().User!.Value;
    Require(SealPipePeerIdentity.Matches(server, me), "impersonated_user_sid");
    Require(!SealPipePeerIdentity.Matches(server, "S-1-5-18"), "reject_system_expected");
    Require(!SealPipePeerIdentity.Matches(server, "S-1-5-21-111-222-333-1001"), "reject_other_account");
}
Console.WriteLine("RELEASE_SEALER_CSHARP_PIPE_IDENTITY_REGRESSION_PASS");

string expectedSid = System.Security.Principal.WindowsIdentity.GetCurrent().User!.Value;
string protectedSddl = SealPipeSecurityPolicy.Build(expectedSid);
SealPipeSecurityPolicy.Verify(protectedSddl, expectedSid);
Require((SealPipeSecurityPolicy.BrokerAccessMask & 0x4) == 0, "broker_no_create_pipe_instance");
void RejectAcl(string sddl, string name)
{
    bool rejected = false;
    try { SealPipeSecurityPolicy.Verify(sddl, expectedSid); }
    catch (InvalidOperationException) { rejected = true; }
    Require(rejected, name);
}
RejectAcl(protectedSddl.Replace("O:SY", "O:BA", StringComparison.Ordinal), "wrong_owner");
RejectAcl(protectedSddl.Replace("D:P", "D:", StringComparison.Ordinal), "inherited_dacl");
RejectAcl(protectedSddl.Replace("0x0012019B", "0x0012019F", StringComparison.Ordinal), "broker_create_instance");
RejectAcl(protectedSddl + "(A;;GA;;;WD)", "everyone_allowed");
RejectAcl(protectedSddl.Replace(expectedSid + ")", "S-1-5-7)", StringComparison.Ordinal), "wrong_broker_sid");
bool invalidBroker = false;
try { SealPipeSecurityPolicy.Build("S-1-5-18"); }
catch (ArgumentException) { invalidBroker = true; }
Require(invalidBroker, "system_is_not_broker");
Console.WriteLine("RELEASE_SEALER_CSHARP_SDDL_REGRESSION_PASS");

// Refuse privileged pipe creation from an interactive user, regardless of
// whether that user holds an elevated Administrators token.
bool factoryBlocked = false;
try { using var forbidden = SealPipeNativeFactory.Create(expectedSid); }
catch (UnauthorizedAccessException) { factoryBlocked = true; }
Require(factoryBlocked, "interactive_factory_denied");

// Native Windows API must actually apply the supplied security descriptor.
// This disposable smoke uses the interactive user's SID as owner, never the
// privileged SYSTEM-only factory. It does not start a service or read keys.
var testSecurity = new System.IO.Pipes.PipeSecurity();
string fixtureSddl = $"O:{expectedSid}G:{expectedSid}D:P(A;;0x001F01FF;;;{expectedSid})";
testSecurity.SetSecurityDescriptorSddlForm(fixtureSddl);
string aclPipeName = "console-mcp-sddl-applied-fixture-" + Guid.NewGuid().ToString("N");
using (var bound = System.IO.Pipes.NamedPipeServerStreamAcl.Create(
    aclPipeName, System.IO.Pipes.PipeDirection.InOut, 1,
    System.IO.Pipes.PipeTransmissionMode.Byte, System.IO.Pipes.PipeOptions.Asynchronous,
    4096, 4096, testSecurity, System.IO.HandleInheritability.None))
{
    var applied = System.IO.Pipes.PipesAclExtensions.GetAccessControl(bound);
    var appliedDescriptor = new System.Security.AccessControl.RawSecurityDescriptor(
        applied.GetSecurityDescriptorSddlForm(System.Security.AccessControl.AccessControlSections.All));
    Require(appliedDescriptor.Owner?.Value == expectedSid, "native_owner_applied");
    Require((appliedDescriptor.ControlFlags & System.Security.AccessControl.ControlFlags.DiscretionaryAclProtected) != 0,
        "native_dacl_protected");
    Require(appliedDescriptor.DiscretionaryAcl?.Count == 1, "native_acl_count");
    Require(((System.Security.AccessControl.CommonAce)appliedDescriptor.DiscretionaryAcl![0]).SecurityIdentifier.Value == expectedSid, "native_acl_sid");
    using var matchingClient = new System.IO.Pipes.NamedPipeClientStream(
        ".", aclPipeName, System.IO.Pipes.PipeDirection.InOut);
    using var nativeTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
    var connected = bound.WaitForConnectionAsync(nativeTimeout.Token);
    await matchingClient.ConnectAsync(nativeTimeout.Token);
    await connected;
    Require(bound.IsConnected, "native_acl_connection");
}
Console.WriteLine("RELEASE_SEALER_CSHARP_NATIVE_PIPE_ACL_REGRESSION_PASS");

Require(!SealAuthorityFileAdmission.Check(
    @"C:\ProgramData\ConsoleMcp\seal-authority\broker-hmac.key"),
    "interactive_token_must_not_admit_key");
Require(!SealAuthorityFileAdmission.Check(
    @"C:\ProgramData\ConsoleMcp\seal-authority\..\broker-hmac.key"),
    "traversal_not_admitted");
Require(!SealAuthorityFileAdmission.Check(
    Path.Combine(Path.GetTempPath(), "broker-hmac.key")),
    "arbitrary_temp_key_not_admitted");
Console.WriteLine("RELEASE_SEALER_CSHARP_AUTHORITY_FILE_NEGATIVE_REGRESSION_PASS");

string replayDir = Path.Combine(Path.GetTempPath(), "console-mcp-replay-fixture-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(replayDir);
try
{
    string once = new string('a', 32);
    Require(SealReplayJournal.TryClaim(replayDir, once), "first_claim");
    Require(SealReplayJournal.IsClaimed(replayDir, once), "persisted_claim");
    Require(!SealReplayJournal.TryClaim(replayDir, once), "duplicate_claim");
    Require(!SealReplayJournal.TryClaim(replayDir, "../escape"), "reject_traversal");
    Require(!SealReplayJournal.TryClaim(replayDir, new string('A', 32)), "reject_uppercase");
    Require(SealReplayJournal.IsClaimed(replayDir, "../escape"), "invalid_id_fail_closed");
    string concurrent = new string('b', 32);
    Task<bool>[] contenders = Enumerable.Range(0, 12).Select(_ =>
        Task.Run(() => SealReplayJournal.TryClaim(replayDir, concurrent))).ToArray();
    bool[] won = await Task.WhenAll(contenders);
    Require(won.Count(w => w) == 1, "exactly_one_concurrent_claim");
    Require(SealReplayJournal.IsClaimed(replayDir, concurrent), "concurrent_persisted");
    // Existing torn/empty claim is *never* retried or overwritten.
    string truncated = new string('c', 32);
    File.WriteAllBytes(Path.Combine(replayDir, truncated + ".claim"), []);
    Require(!SealReplayJournal.TryClaim(replayDir, truncated), "torn_claim_denied");
    Require(SealReplayJournal.IsClaimed(replayDir, truncated), "torn_claim_stays_reserved");
    Require(!SealReplayJournal.TryClaim(Path.Combine(replayDir, "missing"), new string('d', 32)),
        "missing_directory_refused");
    Console.WriteLine("RELEASE_SEALER_CSHARP_DURABLE_REPLAY_REGRESSION_PASS");
    Require(!SealReplayJournalRootAdmission.Check(replayDir), "untrusted_user_journal_denied");
    Require(!SealReplayJournalRootAdmission.Check(SealReplayJournalRootAdmission.JournalRoot), "interactive_system_journal_denied");
    Require(!SealReplayJournalRootAdmission.Check(Path.Combine(replayDir, "..", "escape")), "alternate_journal_denied");
    Console.WriteLine("RELEASE_SEALER_CSHARP_JOURNAL_ROOT_NEGATIVE_REGRESSION_PASS");
Require(SealReplayTrustedRootOpen.Open() is null, "non_system_fixed_root_open_denied");
Console.WriteLine("RELEASE_SEALER_CSHARP_TRUSTED_ROOT_NEGATIVE_REGRESSION_PASS");
    using var admittedHandle = ReplayFixtureHandle.Open(replayDir);
    // Test the actual directory handle's security descriptor, not a
    // second pathname check, before issuing handle-relative claims.
    Require(!SealReplayDirectoryHandleAdmission.Verify(admittedHandle, expectedSid),
        "inherited_directory_acl_denied");
    var fixtureInfo = new DirectoryInfo(replayDir);
    var fixtureAcl = System.IO.FileSystemAclExtensions.GetAccessControl(fixtureInfo);
    fixtureAcl.SetOwner(new System.Security.Principal.SecurityIdentifier(expectedSid));
    fixtureAcl.SetAccessRuleProtection(true, false);
    foreach (System.Security.AccessControl.FileSystemAccessRule rule in
        fixtureAcl.GetAccessRules(true, false, typeof(System.Security.Principal.SecurityIdentifier)))
        fixtureAcl.RemoveAccessRuleAll(rule);
    fixtureAcl.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(
        new System.Security.Principal.SecurityIdentifier(expectedSid),
        System.Security.AccessControl.FileSystemRights.FullControl,
        System.Security.AccessControl.InheritanceFlags.ContainerInherit |
            System.Security.AccessControl.InheritanceFlags.ObjectInherit,
        System.Security.AccessControl.PropagationFlags.None,
        System.Security.AccessControl.AccessControlType.Allow));
    System.IO.FileSystemAclExtensions.SetAccessControl(fixtureInfo, fixtureAcl);
    Require(SealReplayDirectoryHandleAdmission.Verify(admittedHandle, expectedSid),
        "protected_directory_handle_admitted");
    Require(!SealReplayDirectoryHandleAdmission.Verify(admittedHandle, "S-1-5-18"),
        "different_directory_owner_denied");

    string handleOnce = new string('e', 32);
    Require(SealReplayHandleClaim.TryClaim(admittedHandle, handleOnce), "handle_first_claim");
    Require(SealReplayJournal.IsClaimed(replayDir, handleOnce), "handle_claim_exists");
    Require(!SealReplayHandleClaim.TryClaim(admittedHandle, handleOnce), "handle_duplicate_denied");
    Require(!SealReplayHandleClaim.TryClaim(admittedHandle, "../escape"), "handle_bad_id_denied");
    string handleConcurrent = new string('f', 32);
    Task<bool>[] nativeContenders = Enumerable.Range(0, 12).Select(_ =>
        Task.Run(() => SealReplayHandleClaim.TryClaim(admittedHandle, handleConcurrent))).ToArray();
    bool[] nativeWinners = await Task.WhenAll(nativeContenders);
    Require(nativeWinners.Count(x => x) == 1, "handle_one_winner");
    Console.WriteLine("RELEASE_SEALER_CSHARP_BOUND_HANDLE_REPLAY_PASS");

// Three opened directory handles, all with protected explicit ACLs.
// No production ProgramData path or privileged process is used.
string chainManaged = Path.Combine(Path.GetTempPath(), "console-mcp-chain-fixture-" + Guid.NewGuid().ToString("N"));
string chainAuthority = Path.Combine(chainManaged, "seal-authority");
string chainJournal = Path.Combine(chainAuthority, "replay-journal");
Directory.CreateDirectory(chainJournal);
try
{
    foreach (string dir in new[] { chainManaged, chainAuthority, chainJournal })
    {
        var info = new DirectoryInfo(dir);
        var acl = System.IO.FileSystemAclExtensions.GetAccessControl(info);
        acl.SetOwner(new System.Security.Principal.SecurityIdentifier(expectedSid));
        acl.SetAccessRuleProtection(true, false);
        foreach (System.Security.AccessControl.FileSystemAccessRule rule in
            acl.GetAccessRules(true, false, typeof(System.Security.Principal.SecurityIdentifier)))
            acl.RemoveAccessRuleAll(rule);
        acl.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(
            new System.Security.Principal.SecurityIdentifier(expectedSid),
            System.Security.AccessControl.FileSystemRights.FullControl,
            System.Security.AccessControl.InheritanceFlags.ContainerInherit |
                System.Security.AccessControl.InheritanceFlags.ObjectInherit,
            System.Security.AccessControl.PropagationFlags.None,
            System.Security.AccessControl.AccessControlType.Allow));
        System.IO.FileSystemAclExtensions.SetAccessControl(info, acl);
    }
    using (var rootHandle = ReplayFixtureHandle.Open(chainManaged))
    using (var authorityHandle = SealReplayRelativeDirectoryOpen.OpenChild(rootHandle, "seal-authority"))
    using (var journalHandle = authorityHandle is null ? null :
        SealReplayRelativeDirectoryOpen.OpenChild(authorityHandle, "replay-journal"))
    {
        if (authorityHandle is null || journalHandle is null)
            throw new Exception("relative_chain_open_failed");
        Require(SealReplayRelativeDirectoryOpen.OpenChild(rootHandle, "../escape") is null,
            "relative_traversal_denied");
        Require(SealReplayRelativeDirectoryOpen.OpenChild(rootHandle, "replay-journal") is null,
            "relative_wrong_child_denied");
        Require(SealReplayHandleChainAdmission.Verify(rootHandle, authorityHandle,
            journalHandle, chainManaged, expectedSid), "exact_open_handle_chain");
        Require(!SealReplayHandleChainAdmission.Verify(rootHandle, journalHandle,
            authorityHandle, chainManaged, expectedSid), "swapped_chain_handles");
        Require(!SealReplayHandleChainAdmission.Verify(rootHandle, authorityHandle,
            journalHandle, chainManaged + "-other", expectedSid), "wrong_chain_root");
        Require(!SealReplayHandleChainAdmission.Verify(rootHandle, authorityHandle,
            journalHandle, chainManaged, "S-1-5-18"), "wrong_chain_owner");
        Require(!SealReplayHandleChainAdmission.Verify(rootHandle, authorityHandle,
            rootHandle, chainManaged, expectedSid), "duplicate_handle_identity");
        using (var lease = SealReplayVerifiedChain.OpenFromAttestedRoot(
            ReplayFixtureHandle.Open(chainManaged), chainManaged, expectedSid))
        {
            if (lease is null || !lease.IsOpen)
                throw new Exception("verified_chain_lease_created");
            Require(lease.VerifyAgain(chainManaged, expectedSid), "lease_reverify");
            Require(!lease.VerifyAgain(chainManaged, "S-1-5-18"), "lease_wrong_owner_denied");
        }
        Require(SealReplayVerifiedChain.OpenForSystem() is null,
            "interactive_system_lease_denied");
    }
    Console.WriteLine("RELEASE_SEALER_CSHARP_HANDLE_CHAIN_REGRESSION_PASS");
}
finally
{
    Directory.Delete(chainManaged, recursive: true);
}

}
finally
{
    Directory.Delete(replayDir, recursive: true); // disposable fixture only
}


