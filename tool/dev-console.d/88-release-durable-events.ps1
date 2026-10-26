# Isolated append-only event persistence. This module never controls runtime.
# The caller must authenticate events; filesystem contents are not trusted receipts.
function Assert-RuntimeReleaseEventDirectory {
    param([Parameter(Mandatory=$true)][string]$Directory)
    foreach ($item in @(Get-ChildItem -LiteralPath $Directory -Force -ErrorAction Stop)) {
        if ($item.PSIsContainer -or ($item.Name -cne '.event-stream.lock' -and
            $item.Name -cnotmatch '^[0-9]{12}\.json$')) {
            throw "Unexpected release journal entry: $($item.Name)"
        }
    }
}
function Add-RuntimeReleaseDurableEvent {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$Directory,
        [Parameter(Mandatory=$true)][psobject]$InitialSnapshot,
        [Parameter(Mandatory=$true)][psobject]$Event
    )
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) {
        throw 'Event directory does not exist.'
    }
    $lockFile = Join-Path $Directory '.event-stream.lock'
    $lock = [System.IO.File]::Open($lockFile,[System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None)
    try {
        Assert-RuntimeReleaseEventDirectory -Directory $Directory
        $files = @(Get-ChildItem -LiteralPath $Directory -Filter '*.json' -File | Sort-Object Name)
        $events = @()
        $expected = 1
        foreach ($file in $files) {
            if ($file.Name -cne ('{0:D12}.json' -f $expected)) {
                throw 'Event stream has missing, duplicate, or unexpected sequence filenames.'
            }
            $events += (Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json)
            $expected++
        }
        $replayed = Invoke-RuntimeReleaseReplay -InitialSnapshot $InitialSnapshot -Events $events
        $next = Invoke-RuntimeReleaseEvent -Snapshot $replayed.snapshot -Event $Event
        if ($next.sequence -gt 999999999999) { throw 'Event stream sequence exceeds filename capacity.' }
        $target = Join-Path $Directory ('{0:D12}.json' -f $next.sequence)
        $payload = $Event | ConvertTo-Json -Depth 16
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($payload)
        $stream = [System.IO.File]::Open($target,[System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,[System.IO.FileShare]::None)
        try {
            $stream.Write($bytes,0,$bytes.Length)
            $stream.Flush($true)
        } finally { $stream.Dispose() }
        return $next
    } finally { $lock.Dispose() }
}
function Read-RuntimeReleaseDurableEvents {
    # A reader must reject unknown entries rather than silently skip them.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$Directory,
        [Parameter(Mandatory=$true)][psobject]$InitialSnapshot
    )
    Assert-RuntimeReleaseEventDirectory -Directory $Directory
    $files = @(Get-ChildItem -LiteralPath $Directory -Filter '*.json' -File | Sort-Object Name)
    $events = @()
    $expected = 1
    foreach ($file in $files) {
        if ($file.Name -cne ('{0:D12}.json' -f $expected)) { throw 'Event stream gap or unexpected filename.' }
        $events += (Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json)
        $expected++
    }
    Invoke-RuntimeReleaseReplay -InitialSnapshot $InitialSnapshot -Events $events
}
