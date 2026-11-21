# Read-only bytes-to-signed-inventory binding for v3 release descriptors.
# The existing descriptor holds hashes only; derive byte lengths from disk and
# independently rehash every runtime member before comparing to seal receipt.
function Assert-ReleaseV3ReceiptInventory {
    param([Parameter(Mandatory=$true)]$Descriptor,
          [Parameter(Mandatory=$true)][string]$ExpectedInventorySha256)
    if($null -eq $Descriptor -or [string]::IsNullOrWhiteSpace([string]$Descriptor.root) -or
        $null -eq $Descriptor.files -or $Descriptor.files.Count -lt 1){
        throw 'RELEASE_SEAL_INVENTORY_DESCRIPTOR_INVALID'
    }
    if($ExpectedInventorySha256 -cnotmatch '^[0-9a-f]{64}$'){
        throw 'RELEASE_SEAL_INVENTORY_DIGEST_INVALID'
    }
    $root=[IO.Path]::GetFullPath([string]$Descriptor.root)
    $members=@{}
    foreach($name in @($Descriptor.files.Keys)){
        $standard=([string]$name).Replace([char]92,'/')
        if($members.ContainsKey($standard)){throw 'RELEASE_SEAL_INVENTORY_DUPLICATE_PATH'}
        $path=Assert-ReleaseV3SafeMemberPath -Root $root -Name ([string]$name)
        $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){
            throw 'RELEASE_SEAL_INVENTORY_MEMBER_INVALID'
        }
        $hash=(Get-FileHash -LiteralPath $path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
        if($hash -cne [string]$Descriptor.files[$name]){throw 'RELEASE_SEAL_INVENTORY_FILE_DRIFT'}
        $members[$standard]=@{sha256=$hash;size=[long]$item.Length}
    }
    # Detect runtime payload members omitted from the signed descriptor using
    # the same allowlisted runtime inventory as release-v3 descriptors.
    $actual=Get-ReleaseV3Descriptor $root ([string]$Descriptor.sha)
    if($actual.files.Count -ne $Descriptor.files.Count){throw 'RELEASE_SEAL_INVENTORY_MEMBER_DRIFT'}
    foreach($name in $actual.files.Keys){
        $standard=([string]$name).Replace([char]92,'/')
        if(-not $members.ContainsKey($standard) -or
           $members[$standard].sha256 -cne $actual.files[$name]){
            throw 'RELEASE_SEAL_INVENTORY_MEMBER_DRIFT'
        }
    }
    $digest=Get-ReleaseV3InventoryDigest -Files $members
    if($digest.inventory_sha256 -cne $ExpectedInventorySha256){
        throw 'RELEASE_SEAL_INVENTORY_DIGEST_DRIFT'
    }
    return [pscustomobject]@{status='RELEASE_SEAL_INVENTORY_VERIFIED'
      inventory_sha256=$digest.inventory_sha256;file_count=$members.Count
      bytes_rechecked=$true;authorization_granted=$false;mutation_performed=$false}
}
