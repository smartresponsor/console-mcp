# Release code is isolated; the existing control directory, secrets and watchdog remain stable.
function Get-DeploymentDirectory { return (Join-Path $RunDir 'deployments') }
function Get-DeploymentGit {
    param([string]$At, [string[]]$Arguments)
    $value = & git -C $At @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Git deployment inspection failed: $value" }
    return (($value | Out-String).Trim())
}
function Assert-ConsoleReleasePath {
    param([string]$Path)
    $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    $common = Get-DeploymentGit $resolved @('rev-parse','--path-format=absolute','--git-common-dir')
    $controlCommon = Get-DeploymentGit $ControlRootPath @('rev-parse','--path-format=absolute','--git-common-dir')
    if ($common -ine $controlCommon) { throw 'Release belongs to a different repository' }
    if (-not (Test-Path -LiteralPath (Join-Path $resolved 'dist/index.js'))) { throw 'Release build missing' }
    return $resolved
}
function Get-ConsoleReleaseFingerprint {
    param([string]$Path)
    # Includes dirty tracked/untracked work and built output. Never changes the index or refs.
    $records = [System.Collections.Generic.List[string]]::new()
    $records.Add((Get-DeploymentGit $Path @('rev-parse','HEAD')))
    $records.Add((Get-DeploymentGit $Path @('status','--porcelain=v2','--branch')))
    $files = @(& git -C $Path ls-files --cached --others --exclude-standard)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inventory release files' }
    foreach ($dir in @('dist','node_modules')) {
        $directory = Join-Path $Path $dir
        if (Test-Path -LiteralPath $directory) {
            $files += @(Get-ChildItem -LiteralPath $directory -Recurse -File | ForEach-Object { [IO.Path]::GetRelativePath($Path,$_.FullName) })
        }
    }
    foreach ($file in @($files | Sort-Object -Unique)) {
        $absolute = Join-Path $Path $file
        $hash = if (Test-Path -LiteralPath $absolute -PathType Leaf) { (Get-FileHash -LiteralPath $absolute -Algorithm SHA256).Hash } else { 'MISSING' }
        $records.Add("${file}:$hash")
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes(($records -join "`n"))
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))
}
function Copy-ConsoleRollbackRelease {
    param([string]$Path, [string]$Id)
    $snapshot = Join-Path (Split-Path $ControlRootPath) "console-mcp-rollback-$Id"
    $before = Get-ConsoleReleaseFingerprint $Path
    $sha = Get-DeploymentGit $Path @('rev-parse','HEAD')
    & git -C $Path worktree add --no-checkout --detach $snapshot $sha 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot allocate isolated rollback worktree' }
    $files = @(& git -C $Path ls-files --cached --others --exclude-standard)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inventory rollback source' }
    foreach ($dir in @('dist','node_modules')) {
        $files += @(Get-ChildItem -LiteralPath (Join-Path $Path $dir) -Recurse -File | ForEach-Object { [IO.Path]::GetRelativePath($Path,$_.FullName) })
    }
    $files += 'var/run/console-mcp-build-info.json'
    foreach ($file in @($files | Sort-Object -Unique)) {
        $source = Join-Path $Path $file
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
        $destination = Join-Path $snapshot $file
        New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination
        if ((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $destination).Hash) { throw "Rollback copy mismatch: $file" }
    }
    $index = Get-DeploymentGit $Path @('rev-parse','--path-format=absolute','--git-path','index')
    $snapshotIndex = Get-DeploymentGit $snapshot @('rev-parse','--path-format=absolute','--git-path','index')
    Copy-Item -LiteralPath $index -Destination $snapshotIndex
    if ((Get-ConsoleReleaseFingerprint $Path) -ne $before) { throw 'Runtime source changed while freezing rollback' }
    return (Assert-ConsoleReleasePath $snapshot)
}
function Initialize-ConsoleReleaseContext {
    $selection = Join-Path (Get-DeploymentDirectory) 'selected.json'
    $script:Root = $ControlRootPath
    if (Test-Path -LiteralPath $selection) {
        $record = Get-Content -LiteralPath $selection -Raw | ConvertFrom-Json
        $script:Root = Assert-ConsoleReleasePath $record.path
    }
    $script:BuildInfoFile = Join-Path $script:Root 'var/run/console-mcp-build-info.json'
}
function Set-ConsoleRelease {
    param([string]$Path)
    $resolved = Assert-ConsoleReleasePath $Path
    Write-ServerControlJsonAtomically -Path (Join-Path (Get-DeploymentDirectory) 'selected.json') -Value @{ path=$resolved }
    $script:Root = $resolved
    $script:BuildInfoFile = Join-Path $resolved 'var/run/console-mcp-build-info.json'
    $script:BuildOutputReportCache = $null
    New-Item -ItemType Directory -Force -Path (Split-Path $script:BuildInfoFile) | Out-Null
}
function Write-ConsoleDeploymentBuildInfo {
    param([string]$CandidatePath)
    # npm build does not emit the supervisor's fingerprint record. Record the
    # checked artifacts here so the live watchdog never needs to rebuild them.
    $Root = $CandidatePath
    $BuildInfoFile = Join-Path $Root 'var/run/console-mcp-build-info.json'
    $savedCache = $script:BuildOutputReportCache
    $savedCacheAt = $script:BuildOutputReportCacheAt
    try {
        $report = Get-BuildOutputReport -Force
        if (-not $report.dist_index.exists -or $report.source_fingerprint.file_count -eq 0 -or
            ($report.newest_build_input -and [datetime]$report.newest_build_input.last_write_time -gt [datetime]$report.dist_index.last_write_time)) {
            throw 'Validated build metadata requires existing output newer than its inputs'
        }
        $report.build_current = $true
        $report.build_needed = $false
        $report.build_reason = 'validated_deployment'
        $report.build_info_written = $true
        New-Item -ItemType Directory -Force -Path (Split-Path $BuildInfoFile) | Out-Null
        Write-ServerControlJsonAtomically -Path $BuildInfoFile -Value $report
    } finally {
        $script:BuildOutputReportCache = $savedCache
        $script:BuildOutputReportCacheAt = $savedCacheAt
    }
}
function New-ConsoleDeployment {
    param([string]$CandidatePath, [string]$ExpectedCommit)
    $directory = Get-DeploymentDirectory
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $id = [guid]::NewGuid().ToString('N')
    $candidate = Assert-ConsoleReleasePath $CandidatePath
    $preflight = & pwsh -NoProfile -File (Join-Path $candidate 'tool/runtime-deployment-preflight.ps1') -WorkspacePath $ControlRootPath -CandidatePath $candidate -ExpectedCommit $ExpectedCommit
    if ($LASTEXITCODE -ne 0) { throw "Deployment preflight failed: $preflight" }
    $baseline = Get-ConsoleReleaseFingerprint $ControlRootPath
    $checks = @('typecheck','build','schema:validate','admission:check','test:deployment-preflight','test:deployment')
    foreach ($check in $checks) {
        Push-Location $candidate
        try { $output = & (Get-NpmCommand) run $check 2>&1; $code = $LASTEXITCODE } finally { Pop-Location }
        $log = Join-Path $directory "$id-$($check.Replace(':','-')).log"
        $output | Set-Content -LiteralPath $log
        if ($code -ne 0) { throw "Deployment validation failed: $check; exit_code=$code; transcript_path=$log; output=$output" }
    }
    if ((Get-ConsoleReleaseFingerprint $ControlRootPath) -ne $baseline) { throw 'Active checkout changed during validation' }
    if (Get-DeploymentGit $candidate @('status','--porcelain')) { throw 'Candidate must be committed before deployment' }
    Write-ConsoleDeploymentBuildInfo $candidate
    $previousRuntimeFingerprint = Get-ConsoleReleaseFingerprint $Root
    $rollback = Copy-ConsoleRollbackRelease -Path $Root -Id $id
    $receipt = [ordered]@{
        id=$id; phase='validated'; candidate=$candidate; expected_commit=$ExpectedCommit
        candidate_fingerprint=(Get-ConsoleReleaseFingerprint $candidate)
        previous_runtime=$Root; previous_runtime_fingerprint=$previousRuntimeFingerprint
        previous=$rollback; previous_fingerprint=(Get-ConsoleReleaseFingerprint $rollback)
        active_fingerprint=$baseline; checks=$checks
        expires_at=(Get-Date).ToUniversalTime().AddHours(1).ToString('o')
    }
    Write-ServerControlJsonAtomically -Path (Join-Path $directory "$id.json") -Value $receipt
    return [pscustomobject]@{ ok=$true; status='DEPLOYMENT_VALIDATED'; deployment_id=$id; candidate=$candidate; commit=$ExpectedCommit }
}
function Assert-ConsoleDeploymentSession {
    $session = (Get-Process -Id $PID).SessionId
    $active = (Get-ConsoleSessionReport).active_console
    if (-not $active -or $session -ne $active.id) { throw 'Deployment requires the active interactive watchdog session' }
    $broker = Get-ServerControlBrokerIdentity
    if (-not $broker -or [int]$broker.pid -ne $PID) { throw 'Only the owning watchdog broker can deploy' }
}
function Test-ConsoleDeploymentHealth {
    $smoke = Invoke-CodexSmoke -Origin $CodexOrigin -Label 'deployment' -Quiet
    $authenticated = $smoke.authenticated_smoke
    $oauth = Invoke-ChatgptSmoke -Origin $ChatgptOrigin -Label 'deployment-oauth' -Quiet
    $public = Invoke-ChatgptSmoke -Origin $PublicOrigin -Label 'deployment-public' -Quiet
    $expectedPid = Get-ManagedPid -PidFile $UnifiedPidFile
    $health = $authenticated.health.structuredContent
    if (-not $health) { $health = $authenticated.health.content[0].text | ConvertFrom-Json }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$expectedPid"
    $ports = @(Get-NetTCPConnection -State Listen -LocalPort 3333,3334,3335 -ErrorAction SilentlyContinue)
    $ok = $smoke.ok -and $authenticated.ok -and $oauth.ok -and $public.ok -and $health.ok -and
        $health.pid -eq $expectedPid -and $health.process.cwd -ieq $Root -and
        $process.SessionId -eq (Get-Process -Id $PID).SessionId -and
        @($ports | Where-Object OwningProcess -ne $expectedPid).Count -eq 0 -and $ports.Count -eq 3
    return [pscustomobject]@{ ok=[bool]$ok; pid=$expectedPid; archive_available=($authenticated.list_tools -contains 'write.repo.git.archive.ref.push'); oauth_ok=$oauth.ok; public_ok=$public.ok }
}
function Restore-ConsoleDeployment {
    param($Receipt)
    Assert-ConsoleDeploymentSession
    # Refuse to substitute changed code for the saved rollback version.
    if ((Get-ConsoleReleaseFingerprint $Receipt.previous) -ne $Receipt.previous_fingerprint) { throw 'Rollback release fingerprint changed' }
    Stop-UnifiedConsoleRuntime | Out-Null
    Set-ConsoleRelease $Receipt.previous
    Start-UnifiedConsoleRuntime | Out-Null
    $health = Test-ConsoleDeploymentHealth
    if (-not $health.ok) { throw 'Rollback health check failed' }
    $Receipt.phase = 'rolled_back'
    Write-ServerControlJsonAtomically -Path (Join-Path (Get-DeploymentDirectory) "$($Receipt.id).json") -Value $Receipt
    Write-ServerControlJsonAtomically -Path (Join-Path (Get-DeploymentDirectory) 'transaction.json') -Value $Receipt
    return $health
}
function Invoke-ConsoleDeployment {
    param([string]$DeploymentId, $Request)
    Assert-ConsoleDeploymentSession
    $transactionPath = Join-Path (Get-DeploymentDirectory) 'transaction.json'
    if (Test-Path -LiteralPath $transactionPath) {
        $transaction = Get-Content -LiteralPath $transactionPath -Raw | ConvertFrom-Json
        if ($transaction.phase -eq 'switching') { throw 'Interrupted deployment requires rollback before a new switch' }
    }
    if ($DeploymentId -notmatch '^[a-f0-9]{32}$') { throw 'Invalid deployment id' }
    if (([datetimeoffset]$Request.deadline_at).UtcDateTime -le (Get-Date).ToUniversalTime()) { throw 'Expired deployment request' }
    $receiptPath = Join-Path (Get-DeploymentDirectory) "$DeploymentId.json"
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    if ($receipt.phase -ne 'validated' -or ([datetimeoffset]$receipt.expires_at).UtcDateTime -le (Get-Date).ToUniversalTime()) { throw 'Deployment receipt is stale or already consumed' }
    if ($receipt.previous_runtime -ine $Root -or (Get-ConsoleReleaseFingerprint $Root) -ne $receipt.previous_runtime_fingerprint) { throw 'Live release changed since prepare' }
    if ((Get-ConsoleReleaseFingerprint $receipt.previous) -ne $receipt.previous_fingerprint) { throw 'Rollback snapshot changed since prepare' }
    if ((Get-ConsoleReleaseFingerprint $ControlRootPath) -ne $receipt.active_fingerprint) { throw 'Active checkout changed since prepare' }
    $candidate = Assert-ConsoleReleasePath $receipt.candidate
    if ((Get-DeploymentGit $candidate @('rev-parse','HEAD')) -ne $receipt.expected_commit -or
        (Get-ConsoleReleaseFingerprint $candidate) -ne $receipt.candidate_fingerprint) { throw 'Candidate changed since validation' }
    # Durable intent precedes the first mutation. Restarting this broker rolls back
    # an unfinished transaction before permitting any cadence repair or new request.
    $receipt.phase = 'switching'
    Write-ServerControlJsonAtomically -Path $receiptPath -Value $receipt
    Write-ServerControlJsonAtomically -Path (Join-Path (Get-DeploymentDirectory) 'transaction.json') -Value $receipt
    try {
        Stop-UnifiedConsoleRuntime | Out-Null
        Set-ConsoleRelease $candidate
        Start-UnifiedConsoleRuntime | Out-Null
        $health = Test-ConsoleDeploymentHealth
        if (-not $health.ok -or -not $health.archive_available) { throw 'Candidate authenticated/OAuth/archive health check failed' }
        if ((Get-ConsoleReleaseFingerprint $candidate) -ne $receipt.candidate_fingerprint) { throw 'Candidate changed during switch' }
        if ((Get-ConsoleReleaseFingerprint $ControlRootPath) -ne $receipt.active_fingerprint) { throw 'Active checkout changed during switch' }
        $receipt.phase = 'committed'
        Write-ServerControlJsonAtomically -Path $receiptPath -Value $receipt
        Write-ServerControlJsonAtomically -Path (Join-Path (Get-DeploymentDirectory) 'transaction.json') -Value $receipt
        return [pscustomobject]@{ok=$true;status='DEPLOYMENT_COMMITTED';runtime_mutated=$true;deployment_id=$DeploymentId;health=$health}
    } catch {
        $failure = $_.Exception.Message
        $rollback = Restore-ConsoleDeployment $receipt
        return [pscustomobject]@{ok=$false;status='DEPLOYMENT_ROLLED_BACK';runtime_mutated=$true;error=$failure;rollback=$rollback}
    }
}
function Restore-InterruptedConsoleDeployment {
    $path = Join-Path (Get-DeploymentDirectory) 'transaction.json'
    if (Test-Path -LiteralPath $path) {
        $receipt = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        if ($receipt.phase -eq 'switching') { Restore-ConsoleDeployment $receipt | Out-Null }
    }
}
