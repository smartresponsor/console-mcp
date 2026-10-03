$ErrorActionPreference = 'Stop'

$wwwRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$source = Join-Path $wwwRoot 'network-mcp'
$archive = Join-Path $wwwRoot 'network-mcp-LEGACY-BUG-backup.zip'

if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    throw "Legacy repository not found: $source"
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $source,
        $archive,
        [System.IO.Compression.CompressionLevel]::Optimal,
        $true
    )
}
$zip = [System.IO.Compression.ZipFile]::OpenRead($archive)
try {
    if ($zip.Entries.Count -le 0) {
        throw "Archive contains no entries: $archive"
    }
    $entryCount = $zip.Entries.Count
} finally {
    $zip.Dispose()
}
if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
    throw "Archive was not created: $archive"
}

$item = Get-Item -LiteralPath $archive
if ($item.Length -le 0) {
    throw "Archive is empty: $archive"
}
[pscustomobject]@{
    ok = ($item.Length -gt 0)
    source = $source
    archive = $archive
    archive_bytes = $item.Length
} | ConvertTo-Json -Depth 4
