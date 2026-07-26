# Build output generation, fingerprinting, build-info persistence, and freshness reporting.

function Ensure-BuildOutput {
    $report = Get-BuildOutputReport
    if ($report.build_current -eq $true) { return $report }

    $buildMutex = New-Object System.Threading.Mutex($false, 'Global\console-mcp-build-lock')
    $mutexAcquired = $false
    try {
        $mutexAcquired = $buildMutex.WaitOne([TimeSpan]::FromSeconds(120))
        if (-not $mutexAcquired) { throw 'Timed out waiting for another console-mcp build to finish.' }

        $report = Get-BuildOutputReport
        if ($report.build_current -eq $true) { return $report }

        Ensure-Directories
        $npm = Get-NpmCommand
        Push-Location $Root
        try {
            $buildOutput = & $npm run build 2>&1
            $exitCode = $LASTEXITCODE
        } finally {
            Pop-Location
        }
        if ($exitCode -ne 0) {
            throw ("npm run build failed before console-mcp server start. {0}" -f (Sanitize-Text (($buildOutput | Out-String).Trim())))
        }

        $distIndex = Join-Path $Root 'dist/index.js'
        if (-not (Test-Path -LiteralPath $distIndex)) { throw 'npm run build completed but dist/index.js was not produced.' }

        $report = Get-BuildOutputReport -Force
        $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $BuildInfoFile -Encoding utf8
        return $report
    } finally {
        if ($mutexAcquired) { $buildMutex.ReleaseMutex() }
        $buildMutex.Dispose()
    }
}

function Get-RepoRelativePath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $rootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if ($fullPath.StartsWith($rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $fullPath.Substring($rootPath.Length).TrimStart([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar).Replace('\', '/')
    }
    return $fullPath.Replace('\', '/')
}

function Get-BuildInputFiles {
    $candidates = @()
    $srcPath = Join-Path $Root 'src'
    if (Test-Path -LiteralPath $srcPath) {
        $candidates += Get-ChildItem -LiteralPath $srcPath -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in @('.ts', '.json') }
    }
    foreach ($file in @('package.json', 'package-lock.json', 'tsconfig.json')) {
        $fullPath = Join-Path $Root $file
        if (Test-Path -LiteralPath $fullPath) { $candidates += Get-Item -LiteralPath $fullPath }
    }
    return @($candidates | Sort-Object FullName -Unique)
}

function Get-DistFingerprintFiles {
    $distPath = Join-Path $Root 'dist'
    if (-not (Test-Path -LiteralPath $distPath)) { return @() }
    return @(Get-ChildItem -LiteralPath $distPath -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in @('.js', '.json', '.map') } | Sort-Object FullName -Unique)
}

function New-FileSetFingerprint {
    param([object[]]$Files)
    $items = @($Files | Where-Object { $_ -and (Test-Path -LiteralPath $_.FullName -PathType Leaf) } | Sort-Object FullName -Unique)
    $lines = @()
    $totalBytes = [int64]0
    $newest = $null
    foreach ($item in $items) {
        $hash = Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256
        $relativePath = Get-RepoRelativePath -Path $item.FullName
        $lines += "$relativePath|$($item.Length)|$($hash.Hash.ToLowerInvariant())"
        $totalBytes += [int64]$item.Length
        if ($null -eq $newest -or $item.LastWriteTimeUtc -gt $newest.LastWriteTimeUtc) { $newest = $item }
    }
    $payload = [string]::Join("`n", $lines)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $fingerprint = ([System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($payload)))).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
    return [pscustomobject]@{
        algorithm = 'sha256'
        sha256 = $fingerprint
        file_count = $items.Count
        total_bytes = $totalBytes
        newest_file = if ($newest) { [pscustomobject]@{ path = Get-RepoRelativePath -Path $newest.FullName; last_write_time = $newest.LastWriteTime } } else { $null }
    }
}

function Get-BuildInfoSnapshot {
    if (-not (Test-Path -LiteralPath $BuildInfoFile -PathType Leaf)) { return $null }
    try { return (Get-Content -LiteralPath $BuildInfoFile -Raw | ConvertFrom-Json -Depth 20) }
    catch { return [pscustomobject]@{ ok = $false; status = 'BUILD_INFO_UNREADABLE'; error = Sanitize-Text $_.Exception.Message } }
}

function Test-BuildCurrent {
    param([object]$DistItem, [object]$NewestSource, [object]$SourceFingerprint, [object]$DistFingerprint, [object]$BuildInfo)
    if (-not $DistItem) { return [pscustomobject]@{ current = $false; reason = 'missing_dist'; build_needed = $true } }

    $recordedSourceHash = $null
    $recordedDistHash = $null
    $recordedFingerprintVersion = $null
    if ($BuildInfo) {
        try { $recordedSourceHash = [string]$BuildInfo.source_fingerprint.sha256 } catch {}
        try { $recordedDistHash = [string]$BuildInfo.dist_fingerprint.sha256 } catch {}
        try { $recordedFingerprintVersion = [int]$BuildInfo.fingerprint_version } catch {}
    }

    if ($recordedFingerprintVersion -eq 1 -and -not [string]::IsNullOrWhiteSpace($recordedSourceHash)) {
        if ($recordedSourceHash -ne [string]$SourceFingerprint.sha256) {
            if ($NewestSource -and $NewestSource.LastWriteTimeUtc -le $DistItem.LastWriteTimeUtc) { return [pscustomobject]@{ current = $true; reason = 'current'; build_needed = $false } }
            return [pscustomobject]@{ current = $false; reason = 'fingerprint_mismatch'; build_needed = $true }
        }
        if (-not [string]::IsNullOrWhiteSpace($recordedDistHash) -and $recordedDistHash -ne [string]$DistFingerprint.sha256) {
            return [pscustomobject]@{ current = $false; reason = 'fingerprint_mismatch'; build_needed = $true }
        }
        return [pscustomobject]@{ current = $true; reason = 'current'; build_needed = $false }
    }
    if ($NewestSource -and $NewestSource.LastWriteTimeUtc -gt $DistItem.LastWriteTimeUtc) { return [pscustomobject]@{ current = $false; reason = 'timestamp_newer'; build_needed = $true } }
    if ($BuildInfo -and $recordedFingerprintVersion -ne 1) { return [pscustomobject]@{ current = $false; reason = 'unsupported_fingerprint_version'; build_needed = $true } }
    return [pscustomobject]@{ current = $false; reason = 'unknown'; build_needed = $true }
}

function Test-BuildInfoNeedsUpdate {
    param([object]$BuildInfo, [object]$Report)
    if (-not $BuildInfo) { return $true }
    try { if ([int]$BuildInfo.fingerprint_version -ne [int]$Report.fingerprint_version) { return $true } } catch { return $true }
    try {
        if ([string]$BuildInfo.source_fingerprint.sha256 -ne [string]$Report.source_fingerprint.sha256) { return $true }
        if ([string]$BuildInfo.dist_fingerprint.sha256 -ne [string]$Report.dist_fingerprint.sha256) { return $true }
    } catch { return $true }
    return $false
}

$script:BuildOutputReportCache = $null
$script:BuildOutputReportCacheAt = [datetime]::MinValue

function Get-BuildOutputReport {
    param([int]$CacheTtlSeconds = 3, [switch]$Force)
    if (-not $Force -and $script:BuildOutputReportCache -and ((Get-Date) - $script:BuildOutputReportCacheAt).TotalSeconds -lt $CacheTtlSeconds) { return $script:BuildOutputReportCache }

    $distIndex = Join-Path $Root 'dist/index.js'
    $distItem = Get-Item -LiteralPath $distIndex -ErrorAction SilentlyContinue
    $newestSource = Get-NewestBuildInput
    $sourceFingerprint = New-FileSetFingerprint -Files (Get-BuildInputFiles)
    $distFingerprint = New-FileSetFingerprint -Files (Get-DistFingerprintFiles)
    $buildInfo = Get-BuildInfoSnapshot
    $freshness = Test-BuildCurrent -DistItem $distItem -NewestSource $newestSource -SourceFingerprint $sourceFingerprint -DistFingerprint $distFingerprint -BuildInfo $buildInfo

    $report = [pscustomobject]@{
        dist_index = [pscustomobject]@{ path = $distIndex; exists = [bool]$distItem; length = if ($distItem) { $distItem.Length } else { $null }; last_write_time = if ($distItem) { $distItem.LastWriteTime } else { $null } }
        newest_build_input = if ($newestSource) { [pscustomobject]@{ path = $newestSource.FullName; last_write_time = $newestSource.LastWriteTime } } else { $null }
        build_needed = [bool]$freshness.build_needed
        build_current = [bool]$freshness.current
        build_reason = [string]$freshness.reason
        fingerprint_version = 1
        source_fingerprint = $sourceFingerprint
        dist_fingerprint = $distFingerprint
        build_info_file = $BuildInfoFile
        build_info_written = Test-Path -LiteralPath $BuildInfoFile
    }
    if ($report.build_current -eq $true -and (Test-BuildInfoNeedsUpdate -BuildInfo $buildInfo -Report $report)) {
        $report | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $BuildInfoFile -Encoding utf8
        $report.build_info_written = $true
    }
    $script:BuildOutputReportCache = $report
    $script:BuildOutputReportCacheAt = Get-Date
    return $report
}

function Get-NewestBuildInput {
    return (Get-BuildInputFiles | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1)
}

