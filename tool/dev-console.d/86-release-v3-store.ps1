# Schema 3 is separate from legacy PREPARED-only journals. No legacy migration.
function Write-ReleaseV3Atomic {
    param([string]$Path,[byte[]]$Bytes)
    $tmp = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    $stream = [IO.FileStream]::new($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($Bytes,0,$Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    if ([IO.File]::Exists($Path)) { [IO.File]::Replace($tmp,$Path,[NullString]::Value) }
    else { [IO.File]::Move($tmp,$Path) }
}
function Get-ReleaseV3Mac {
    param([byte[]]$Key,[byte[]]$Bytes)
    $hmac = [Security.Cryptography.HMACSHA256]::new($Key)
    try { return [Convert]::ToHexString($hmac.ComputeHash($Bytes)).ToLowerInvariant() } finally { $hmac.Dispose() }
}
function Write-ReleaseV3Signed {
    param([string]$Path,$Value,[byte[]]$Key)
    $payload = [Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Depth 100 -Compress))
    $envelope = @{payload=[Convert]::ToBase64String($payload);mac=(Get-ReleaseV3Mac $Key $payload)}
    Write-ReleaseV3Atomic $Path ([Text.Encoding]::UTF8.GetBytes(($envelope | ConvertTo-Json -Compress)))
}
function Read-ReleaseV3Signed {
    param([string]$Path,[byte[]]$Key)
    $envelope = [IO.File]::ReadAllText($Path) | ConvertFrom-Json -AsHashtable
    $bytes = [Convert]::FromBase64String($envelope.payload)
    $expected = [Text.Encoding]::ASCII.GetBytes((Get-ReleaseV3Mac $Key $bytes))
    $actual = [Text.Encoding]::ASCII.GetBytes([string]$envelope.mac)
    if (-not [Security.Cryptography.CryptographicOperations]::FixedTimeEquals($expected,$actual)) { throw 'RELEASE_RECEIPT_AUTHENTICATION_FAILED' }
    return ([Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json -AsHashtable -DateKind String)
}
function Open-ReleaseV3Lock {
    param([string]$Directory)
    $null = [IO.Directory]::CreateDirectory($Directory)
    # Reparse points could redirect the single-writer/trust boundary.
    $cursor = [IO.DirectoryInfo]::new([IO.Path]::GetFullPath($Directory))
    while ($null -ne $cursor) {
        if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'RELEASE_STORE_REPARSE_POINT' }
        $cursor = $cursor.Parent
    }
    try { return [IO.File]::Open((Join-Path $Directory 'writer.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
    catch [IO.IOException] { throw 'RELEASE_TRANSACTION_BUSY' }
}
function Add-ReleaseV3Receipt {
    param($State,[string]$Phase,$Observation,[string]$Path,[byte[]]$Key,$Broker)
    $previous = if (@($State.receipts).Count) { $State.receipts[-1].digest } else { '' }
    $receipt = [ordered]@{transaction=$State.id;request=$State.event_request;sequence=(@($State.receipts).Count+1);
        previous=$previous;from=$State.phase;to=$Phase;broker=$Broker;at=[datetimeoffset]::UtcNow.ToString('o');observation=$Observation}
    $bytes = [Text.Encoding]::UTF8.GetBytes(($receipt | ConvertTo-Json -Depth 80 -Compress))
    $State.receipts = @($State.receipts) + @(@{record=$receipt;digest=(Get-ReleaseV3Mac $Key $bytes)})
    $State.phase = $Phase
    Write-ReleaseV3Signed $Path $State $Key
}
function Test-ReleaseV3Receipts {
    param($State,[byte[]]$Key)
    if ($State.schema -ne 3 -or $State.id -notmatch '^[0-9a-f]{32}$' -or -not $State.request) { throw 'RELEASE_JOURNAL_INVALID' }
    $last = ''; $sequence=0; $phase='NEW'
    foreach ($item in $State.receipts) {
        $r=$item.record; $sequence++
        $bytes=[Text.Encoding]::UTF8.GetBytes(($r | ConvertTo-Json -Depth 80 -Compress))
        if ($item.digest -cne (Get-ReleaseV3Mac $Key $bytes) -or $r.previous -cne $last -or
            $r.sequence -ne $sequence -or $r.transaction -cne $State.id -or $r.request -cnotmatch '^[0-9a-f]{32}$' -or $r.from -cne $phase) { throw 'RELEASE_RECEIPT_CHAIN_INVALID' }
        $phase=$r.to; $last=$item.digest
    }
    if ($phase -cne $State.phase -or $sequence -eq 0) { throw 'RELEASE_JOURNAL_PHASE_INVALID' }
}
