# Pure, portable SHA-256 file inventory canonicalizer. Never touches the filesystem.
# This is a digest input for a future privileged sealer, not a seal or signature.
function Get-ReleaseV3InventoryDigest {
    param([Parameter(Mandatory=$true)]$Files)
    if($null -eq $Files -or $Files.Count -lt 1){throw 'RELEASE_INVENTORY_EMPTY'}
    $names=@($Files.Keys | Sort-Object -CaseSensitive)
    $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $rows=[Collections.Generic.List[string]]::new()
    foreach($name in $names){
        $relative=[string]$name
        if([string]::IsNullOrWhiteSpace($relative) -or
           $relative -match '(^|[\\/])\.{1,2}([\\/]|$)' -or
           $relative -match '[\\:]' -or $relative.StartsWith('/') -or
           $relative -match '[\x00-\x1f\x7f]' -or $relative.EndsWith('/') -or
           $relative.Contains('//')){throw 'RELEASE_INVENTORY_UNSAFE_PATH'}
        if(-not $seen.Add($relative)){throw 'RELEASE_INVENTORY_CASE_COLLISION'}
        $entry=$Files[$name]
        if($null -eq $entry -or -not $entry.ContainsKey('sha256') -or -not $entry.ContainsKey('size')){
            throw 'RELEASE_INVENTORY_ENTRY_INVALID'
        }
        $hash=[string]$entry.sha256
        if($hash -cnotmatch '^[0-9a-f]{64}$'){throw 'RELEASE_INVENTORY_HASH_INVALID'}
        $size=[long]0
        if(-not [long]::TryParse([string]$entry.size,[ref]$size) -or $size -lt 0 -or
           ([string]$entry.size -cnotmatch '^(0|[1-9][0-9]*)$')){
            throw 'RELEASE_INVENTORY_SIZE_INVALID'
        }
        # Length prefix avoids ambiguity with arbitrary UTF-8 filenames.
        $pathBytes=[Text.Encoding]::UTF8.GetBytes($relative)
        $rows.Add(('{0}:{1}:{2}:{3}' -f $pathBytes.Length,$relative,$size,$hash))
    }
    $payload="console-mcp-release-inventory-v1" + "`n" + ($rows -join "`n") + "`n"
    $digest=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($payload))).ToLowerInvariant()
    return [pscustomobject]@{schema_version=1;inventory_sha256=$digest;file_count=$rows.Count;authenticated=$false;mutation_performed=$false}
}

