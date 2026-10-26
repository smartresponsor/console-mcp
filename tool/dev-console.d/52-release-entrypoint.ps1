# Pure validation; no runtime process is started or stopped.
function Resolve-ValidatedReleaseEntrypoint {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true)][string]$Entrypoint)

    if (-not (Test-Path -LiteralPath $Entrypoint -PathType Leaf)) {
        throw 'Release entrypoint does not exist.'
    }
    $resolved = (Resolve-Path -LiteralPath $Entrypoint).Path
    if ([IO.Path]::GetFileName($resolved) -cne 'index.js' -or
        [IO.Path]::GetFileName((Split-Path -Parent $resolved)) -cne 'dist') {
        throw 'Release entrypoint must be dist/index.js.'
    }
    $candidate = Split-Path -Parent (Split-Path -Parent $resolved)
    $sha = (& git -C $candidate rev-parse HEAD 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $sha -notmatch '^[0-9a-fA-F]{40}$') {
        throw 'Release candidate is not a Git checkout.'
    }
    $dirty = (& git -C $candidate status --porcelain 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $dirty) {
        throw 'Release candidate checkout is dirty.'
    }
    $candidateCommon = (& git -C $candidate rev-parse --path-format=absolute --git-common-dir 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Cannot identify candidate Git common directory.' }
    $rootCommon = (& git -C $Root rev-parse --path-format=absolute --git-common-dir 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $candidateCommon -ine $rootCommon -or $candidate -ieq $Root) {
        throw 'Release candidate must be a separate worktree of the active repository.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $candidate 'node_modules') -PathType Container)) {
        throw 'Release candidate dependencies are missing.'
    }
    return $resolved
}
