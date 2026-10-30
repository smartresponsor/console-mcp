function Get-ReleaseV3ConfigurationDigest {
    $parts=[ordered]@{origin=$PublicOrigin;issuer=$OAuthIssuer;audience=$OAuthAudience;scope=$OAuthScope;jwks=$OAuthJwksUri;workspace=$DefaultWorkspaceRoot}
    # Only keyed hashes are retained; environment files and tokens never enter receipts.
    $key=Get-ReleaseV3Key
    $parts.token=Get-ReleaseV3Mac $key ([Text.Encoding]::UTF8.GetBytes([string](Get-ConfiguredSecretValue -Name 'CONSOLE_MCP_BEARER_TOKEN')))
    $parts.files=@(Get-ChildItem -LiteralPath $Root -Force -File | Where-Object {$_.Name -like '.env*'} | Sort-Object Name | ForEach-Object {
        @{name=$_.Name;mac=(Get-ReleaseV3Mac $key ([IO.File]::ReadAllBytes($_.FullName)))}
    })
    return Get-ReleaseV3Mac $key ([Text.Encoding]::UTF8.GetBytes(($parts | ConvertTo-Json -Depth 8 -Compress)))
}
function Assert-ReleaseV3ActivationGates {
    param($State)
    $policyPath=Join-Path $PSScriptRoot '../../policy/runtime-release-v3.json'
    $policy=Get-Content -Raw -LiteralPath $policyPath | ConvertFrom-Json
    if($policy.productionActivationEnabled -cne $true){throw 'RELEASE_V3_POLICY_DISABLED'}
    $directory=Get-ReleaseV3Directory;$key=Get-ReleaseV3Key
    $report=Read-ReleaseV3Signed (Join-Path $directory 'validation.json') $key
    if(-not $report.passed -or $report.sha -cne $State.candidate.sha -or $report.broker.generation -cne $State.broker.generation -or
        ([datetimeoffset]::UtcNow-[datetimeoffset]::Parse($report.at)).TotalMinutes -gt 60){throw 'RELEASE_VALIDATION_STALE'}
    if($report.files.Count -ne $State.candidate.files.Count){throw 'RELEASE_VALIDATION_CONTENT_MISMATCH'}
    foreach($name in $report.files.Keys){if($report.files[$name] -cne $State.candidate.files[$name]){throw 'RELEASE_VALIDATION_CONTENT_MISMATCH'}}
    if($State.candidate.configuration -cne (Get-ReleaseV3ConfigurationDigest)){throw 'RELEASE_CONFIGURATION_DRIFT'}
    if(-not $report.probe.ok -or $report.configuration -cne $State.candidate.configuration -or $report.probe.fingerprint -cne $State.candidate.fingerprint){throw 'RELEASE_HOST_CONFIG_VALIDATION_REQUIRED'}
    # Host files are preserved; compatibility is authenticated against their exact bytes, not new templates.
    foreach($name in $report.probe.hostPolicyHashes.Keys){
        if((Get-FileHash -LiteralPath (Join-Path $Root ('policy/'+$name)) -Algorithm SHA256).Hash -cne $report.probe.hostPolicyHashes[$name]){throw 'RELEASE_HOST_POLICY_DRIFT'}
    }
    $lease=Get-InteractiveDesktopCapabilityLease -RequireVisibleWindow -RequireBrowserReady
    if(-not $lease.ok){throw 'RELEASE_NATIVE_DESKTOP_NOT_READY'}
    $native=& (Join-Path $PSScriptRoot '../visible-browser-native-windows.ps1') -Port 9223 -Operation browser | ConvertFrom-Json
    if(-not $native.sameSession -or -not $native.sameUser -or -not $native.inputReady -or $native.foregroundWindowIdBefore -ne $native.foregroundWindowIdAfter -or
        -not @($native.windows | Where-Object {$_.id -eq $native.foregroundWindowIdAfter -and $_.visible -and -not $_.minimized -and $_.cloaked -eq 0}).Count){throw 'RELEASE_NATIVE_FOREGROUND_NOT_READY'}
    if(($State.candidate.browser | ConvertTo-Json -Depth 30 -Compress) -cne ((Get-ReleaseV3BrowserSnapshot) | ConvertTo-Json -Depth 30 -Compress)){throw 'RELEASE_BROWSER_DRIFT'}
}
function Invoke-ReleaseV3Validation {
    param([string]$CandidatePath,[string]$ExpectedCommit)
    $broker=Assert-ReleaseV3Broker
    $null=Resolve-ValidatedReleaseEntrypoint (Join-Path $CandidatePath 'dist/index.js')
    if((& git -C $CandidatePath rev-parse HEAD).Trim() -cne $ExpectedCommit){throw 'RELEASE_SHA_MISMATCH'}
    $directory=Get-ReleaseV3Directory;$key=Get-ReleaseV3Key
    $lock=Open-ReleaseV3Lock $directory
    try {
        $passed=$true;$configuration=Get-ReleaseV3ConfigurationDigest;$probe=$null
        Push-Location $CandidatePath
        try {
            foreach($step in @(@('run','typecheck'),@('run','build'),@('test'))){
                & (Get-NpmCommand).Source @step *> (Join-Path $directory ('validation-'+($step -join '-')+'.log'))
                if($LASTEXITCODE -ne 0){$passed=$false;break}
            }
            if($passed){
                & (Get-Command pwsh).Source -NoProfile -File (Join-Path $CandidatePath 'tool/runtime-release-v3-regression.ps1') *> (Join-Path $directory 'validation-transaction.log')
                $passed=$LASTEXITCODE -eq 0
            }
            if($passed){
                $probe=& (Get-Command pwsh).Source -NoProfile -File (Join-Path $CandidatePath 'tool/runtime-release-v3-candidate-probe.ps1') -CandidatePath $CandidatePath -ControlRoot $Root | Out-String | ConvertFrom-Json -AsHashtable
                $passed=$LASTEXITCODE -eq 0 -and $probe.ok -and $configuration -ceq (Get-ReleaseV3ConfigurationDigest)
            }
        } finally {Pop-Location}
        $descriptor=Get-ReleaseV3Descriptor $CandidatePath $ExpectedCommit
        $report=@{passed=$passed;sha=$ExpectedCommit;files=$descriptor.files;broker=$broker;probe=$probe;configuration=$configuration;at=[datetimeoffset]::UtcNow.ToString('o')}
        Write-ReleaseV3Signed (Join-Path $directory 'validation.json') $report $key
        return @{ok=$passed;status=if($passed){'RELEASE_VALIDATED'}else{'RELEASE_VALIDATION_FAILED'};sha=$ExpectedCommit;runtime_mutated=$false}
    } finally {$lock.Dispose()}
}
function Invoke-ReleaseV3BrokerAction {
    param($Request)
    $broker=Assert-ReleaseV3Broker
    $directory=Get-ReleaseV3Directory;$key=Get-ReleaseV3Key
    if($Request.operation -eq 'validate'){return Invoke-ReleaseV3Validation $Request.candidate_path $Request.expected_sha}
    # Legacy journals have no trusted terminal receipts and cannot silently migrate.
    $legacy=Join-Path $RunDir 'release-transactions'
    if(Test-Path -LiteralPath $legacy){if(@(Get-ChildItem -LiteralPath $legacy -Filter '*.json').Count){throw 'RELEASE_LEGACY_RECONCILIATION_REQUIRED'}}
    $candidate=$null;$previous=$null
    if($Request.operation -eq 'prepare'){
        if($Request.expected_sha -cnotmatch '^[0-9a-f]{40}$'){throw 'RELEASE_SHA_INVALID'}
        $entry=Resolve-ValidatedReleaseEntrypoint (Join-Path $Request.candidate_path 'dist/index.js')
        if((& git -C $Request.candidate_path rev-parse HEAD).Trim() -cne $Request.expected_sha){throw 'RELEASE_SHA_MISMATCH'}
        & git -C $Request.candidate_path merge-base --is-ancestor $Request.expected_sha origin/master
        if($LASTEXITCODE -ne 0){throw 'RELEASE_NOT_CANONICAL_MASTER_HISTORY'}
        $candidate=Get-ReleaseV3Descriptor $Request.candidate_path $Request.expected_sha
        $candidate.fingerprint=Get-ReleaseV3BuildFingerprint $Request.candidate_path
        $report=Read-ReleaseV3Signed (Join-Path $directory 'validation.json') $key
        if(-not $report.passed -or $report.sha -cne $Request.expected_sha -or -not $report.probe.ok){throw 'RELEASE_VALIDATE_BEFORE_PREPARE'}
        $candidate.registry=$report.probe.registry
        $candidate.browser=Get-ReleaseV3BrowserSnapshot
        $candidate.configuration=Get-ReleaseV3ConfigurationDigest
        $previous=Get-ReleaseV3Descriptor $Request.rollback_path 'previous-runtime-content-attested'
        $previous.fingerprint=Get-ReleaseV3BuildFingerprint $Request.rollback_path
        $previous.browser=$candidate.browser
        $previous.configuration=$candidate.configuration
        $listener=Get-ListeningProcessOnPort -Port 3333
        if(-not $listener){throw 'RELEASE_INCUMBENT_MISSING'}
        $identity=Get-ReleaseV3ProcessIdentity $listener.OwningProcess
        # Restore payload may live elsewhere, but must exactly match the active entrypoint/build.
        $active=Get-ReleaseV3Selected
        $activeRoot=if($active){$active.root}else{$Root}
        if($previous.fingerprint -cne (Get-ReleaseV3BuildFingerprint $activeRoot) -or -not $identity.command.Contains((Join-Path $activeRoot 'dist/index.js'))){throw 'RELEASE_ROLLBACK_NOT_EXACT'}
        foreach($name in $previous.files.Keys){
            $liveFile=Join-Path $activeRoot $name
            if(-not (Test-Path -LiteralPath $liveFile) -or (Get-FileHash -LiteralPath $liveFile -Algorithm SHA256).Hash.ToLowerInvariant() -cne $previous.files[$name]){throw 'RELEASE_ROLLBACK_CONTENT_MISMATCH'}
        }
        $previous.active_entry=Join-Path $activeRoot 'dist/index.js';$previous.incumbent=$identity
    }
    $operations=@{Validate={param($d) Test-ReleaseV3Descriptor $d};Observe={param($c,$p,$t) Get-ReleaseV3RuntimeObservation $c $p $t};
        Stop={param($i) Stop-ReleaseV3Runtime $i};Start={param($d,$t) Start-ReleaseV3Runtime $d $t};
        Verify={param($d,$i) Test-ReleaseV3RuntimeHealth $d $i};Gate={param($s) Assert-ReleaseV3ActivationGates $s;if([datetimeoffset]::Parse($Request.deadline_at) -le [datetimeoffset]::UtcNow){throw 'RELEASE_REQUEST_EXPIRED'}}}
    $state=Invoke-ReleaseV3 $directory $key $broker $Request.operation $Request.transaction_id $candidate $previous $operations $Request.correlation_id
    return @{ok=($state.phase -notin @('RECOVERY_REQUIRED'));status=('RELEASE_'+$state.phase);transaction_id=$state.id;phase=$state.phase;runtime_mutated=($state.phase -in @('COMMITTED','ROLLED_BACK','RECOVERY_REQUIRED'));receipt_count=if($state.receipts){@($state.receipts).Count}else{0}}
}
function Test-ReleaseV3LifecycleAllowed {
    $directory=Get-ReleaseV3Directory
    $path=Join-Path $directory 'transaction.json'
    if(-not (Test-Path -LiteralPath $path)){return $true}
    try {
        $key=Get-ReleaseV3Key -ReadOnly
        $state=Read-ReleaseV3Signed $path $key
        Test-ReleaseV3Receipts $state $key
        return $state.phase -in @('PREPARED','COMMITTED','ROLLED_BACK','ABORTED')
    } catch {return $false}
}
