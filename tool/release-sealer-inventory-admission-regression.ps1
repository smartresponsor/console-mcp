$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/83-release-v3-inventory.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/85-release-v3-sealing.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/76-release-v3-inventory-admission.ps1')
$base=Join-Path ([IO.Path]::GetTempPath()) ('receipt-inventory-'+[guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $base -ErrorAction Stop
try {
    $null=New-Item -ItemType Directory -Path (Join-Path $base 'dist')
    $file=Join-Path $base 'dist/index.js'
    [IO.File]::WriteAllText($file,'valid file bytes')
    $sha=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    $descriptor=@{root=$base;sha=('a'*40);files=@{'dist/index.js'=$sha}}
    function Get-ReleaseV3Descriptor {
        param([string]$Directory,[string]$Sha)
        $found=@{}
        foreach($item in @(Get-ChildItem -LiteralPath (Join-Path $Directory 'dist') -File -Recurse)){
            $name=[IO.Path]::GetRelativePath($Directory,$item.FullName).Replace([char]92,'/')
            $found[$name]=(Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        return @{files=$found}
    }
    $expected=Get-ReleaseV3InventoryDigest -Files @{'dist/index.js'=@{sha256=$sha;size=([IO.FileInfo]::new($file)).Length}}
    $proof=Assert-ReleaseV3ReceiptInventory -Descriptor $descriptor -ExpectedInventorySha256 $expected.inventory_sha256
    if(-not $proof.bytes_rechecked -or $proof.authorization_granted){throw 'INVENTORY_PROOF_INVALID'}
    [IO.File]::WriteAllText($file,'tampered payload!')
    $blocked=$false
    try{$null=Assert-ReleaseV3ReceiptInventory -Descriptor $descriptor -ExpectedInventorySha256 $expected.inventory_sha256}catch{$blocked=$_.Exception.Message -eq 'RELEASE_SEAL_INVENTORY_FILE_DRIFT'}
    if(-not $blocked){throw 'MODIFIED_FILE_ACCEPTED'}
    [IO.File]::WriteAllText($file,'valid file bytes')
    [IO.File]::WriteAllText((Join-Path $base 'dist/extra.js'),'extra')
    $blocked=$false
    try{$null=Assert-ReleaseV3ReceiptInventory -Descriptor $descriptor -ExpectedInventorySha256 $expected.inventory_sha256}catch{$blocked=$_.Exception.Message -eq 'RELEASE_SEAL_INVENTORY_MEMBER_DRIFT'}
    if(-not $blocked){throw 'UNLISTED_FILE_ACCEPTED'}
    Remove-Item -LiteralPath (Join-Path $base 'dist/extra.js') -Force
    $blocked=$false
    try{$null=Assert-ReleaseV3ReceiptInventory -Descriptor $descriptor -ExpectedInventorySha256 ('0'*64)}catch{$blocked=$_.Exception.Message -eq 'RELEASE_SEAL_INVENTORY_DIGEST_DRIFT'}
    if(-not $blocked){throw 'WRONG_SIGNED_DIGEST_ACCEPTED'}
    'RELEASE_SEALER_INVENTORY_ADMISSION_REGRESSION_PASS'
} finally {
    Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction Stop
}
