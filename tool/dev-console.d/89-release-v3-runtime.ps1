function Get-ReleaseV3ProcessIdentity {
    param([int]$ProcessId)
    $p=Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
    if(-not $p){return $null}
    $owner=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction Stop
    if($owner.ReturnValue -ne 0){throw 'RELEASE_PROCESS_OWNER_UNAVAILABLE'}
    return [ordered]@{pid=[int]$p.ProcessId;started=([datetime]$p.CreationDate).ToUniversalTime().ToString('o');
        executable=[string]$p.ExecutablePath;command=[string]$p.CommandLine;session=[int]$p.SessionId;sid=[string]$owner.Sid}
}
function Get-ReleaseV3RuntimeObservation {
    param($Candidate,$Previous,[string]$Transaction)
    $owners=@(foreach($port in @(3333,3334,3335)){ $listener=Get-ListeningProcessOnPort -Port $port; if($listener){[int]$listener.OwningProcess} })
    if(-not $owners.Count){return @{kind='empty';identity=$null}}
    if(@($owners | Select-Object -Unique).Count -ne 1){return @{kind='foreign';identity=$null}}
    $identity=Get-ReleaseV3ProcessIdentity $owners[0]
    $broker=Assert-ReleaseV3Broker
    if(-not $identity -or $identity.session -ne $broker.windows_session_id -or $identity.sid -cne $broker.user_sid -or [IO.Path]::GetFileName($identity.executable) -ine 'node.exe'){return @{kind='foreign';identity=$identity}}
    $kind='foreign'
    if($identity.command.Contains($Candidate.entry) -and $identity.command.Contains('--console-release-transaction='+$Transaction) -and -not $identity.command.Contains($Transaction+'-rollback')){$kind='candidate'}
    elseif($identity.command.Contains($Previous.entry) -or ($Previous.active_entry -and $identity.command.Contains($Previous.active_entry))){
        if($Previous.incumbent -and ($identity | ConvertTo-Json -Compress) -ceq ($Previous.incumbent | ConvertTo-Json -Compress)){$kind='previous'}
        elseif($identity.command.Contains('--console-release-transaction='+$Transaction+'-rollback')){$kind='previous'}
    }
    return @{kind=$kind;identity=$identity}
}
function Stop-ReleaseV3Runtime {
    param($Identity)
    $null=Assert-ReleaseV3Broker
    $actual=Get-ReleaseV3ProcessIdentity $Identity.pid
    if(($actual | ConvertTo-Json -Compress) -cne ($Identity | ConvertTo-Json -Compress)){throw 'RELEASE_STOP_IDENTITY_DRIFT'}
    $null=Invoke-ConsoleServerGracefulThenForceStop -ProcessId $Identity.pid
    if(Get-ReleaseV3ProcessIdentity $Identity.pid){throw 'RELEASE_PROCESS_SURVIVED'}
}
function Start-ReleaseV3Runtime {
    param($Descriptor,[string]$Transaction)
    $null=Assert-ReleaseV3Broker
    Test-ReleaseV3Descriptor $Descriptor
    $script:ReleaseV3Launch=@{descriptor=$Descriptor;transaction=$Transaction}
    try { $null=Start-UnifiedConsoleRuntime -ReleaseEntrypoint $Descriptor.entry }
    finally {$script:ReleaseV3Launch=$null}
    $listener=Get-ListeningProcessOnPort -Port 3333
    if(-not $listener){throw 'RELEASE_START_LISTENER_MISSING'}
    $identity=Get-ReleaseV3ProcessIdentity $listener.OwningProcess
    if(-not $identity.command.Contains('--console-release-transaction='+$Transaction)){throw 'RELEASE_START_IDENTITY_MISMATCH'}
    return $identity
}
function Get-ReleaseV3BrowserSnapshot {
    $result=[ordered]@{}
    foreach($port in @(9223,9224,8791,8793,8795,8797)){
        $listener=Get-ListeningProcessOnPort -Port $port
        if(-not $listener){$result[[string]$port]=$null;continue}
        $process=Get-ReleaseV3ProcessIdentity $listener.OwningProcess
        $entry=[ordered]@{identity=$process}
        if($port -in @(9223,9224)){
            $v=Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 5
            $targets=Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 5
            $entry.instance=([uri]$v.webSocketDebuggerUrl).AbsolutePath
            $entry.targets=@($targets | Sort-Object id | ForEach-Object { [ordered]@{id=$_.id;type=$_.type} })
        }
        $result[[string]$port]=$entry
    }
    return $result
}
function Get-ReleaseV3BuildFingerprint {
    param([string]$Directory)
    $scriptText="import {pathToFileURL} from 'node:url'; const p=process.argv[1]; const m=await import(pathToFileURL(p+'/dist/Infrastructure/Build/BuildFingerprint.js')); console.log(m.buildDirectoryFingerprint(p+'/dist'));"
    $fingerprint=(& (Get-NodeCommand).Source --input-type=module -e $scriptText $Directory | Out-String).Trim()
    if($LASTEXITCODE -ne 0 -or $fingerprint -notmatch '^[a-f0-9]{16}$'){throw 'RELEASE_BUILD_FINGERPRINT_UNAVAILABLE'}
    return $fingerprint
}
function Test-ReleaseV3RuntimeHealth {
    param($Descriptor,$Identity)
    $null=Assert-ReleaseV3Broker
    $smoke=Invoke-CodexSmoke -Origin $CodexOrigin -Label 'release-transaction' -Quiet
    $oauth=Invoke-ChatgptSmoke -Origin $ChatgptOrigin -Label 'release-transaction' -Quiet
    $public=Invoke-ChatgptSmoke -Origin $PublicOrigin -Label 'release-public' -Quiet
    if(-not $smoke.ok -or -not $oauth.ok -or -not $public.ok){throw 'RELEASE_AUTHENTICATED_HEALTH_FAILED'}
    $healthResult=$smoke.authenticated_smoke.health
    $health=if($healthResult.structuredContent){$healthResult.structuredContent}else{$healthResult.content[0].text | ConvertFrom-Json}
    if(-not $health.ok -or $health.pid -ne $Identity.pid -or $health.buildFingerprint -cne $Descriptor.fingerprint -or
        -not $health.canonicalRegistryFingerprint){throw 'RELEASE_DEPLOYED_BUILD_MISMATCH'}
    if($Descriptor.registry -and $health.canonicalRegistryFingerprint -cne $Descriptor.registry){throw 'RELEASE_REGISTRY_MISMATCH'}
    if(-not $Descriptor.registry){$Descriptor.registry=$health.canonicalRegistryFingerprint}
    if($health.process.cwd -ine $Root){throw 'RELEASE_STATE_ROOT_CHANGED'}
    if($Descriptor.configuration -and $Descriptor.configuration -cne (Get-ReleaseV3ConfigurationDigest)){throw 'RELEASE_CONFIGURATION_DRIFT'}
    foreach($port in @(3333,3334,3335)){
        $owner=Get-ListeningProcessOnPort -Port $port
        if(-not $owner -or $owner.OwningProcess -ne $Identity.pid){throw 'RELEASE_PROFILE_OWNER_MISMATCH'}
    }
    if($Descriptor.browser -and ($Descriptor.browser | ConvertTo-Json -Depth 30 -Compress) -cne ((Get-ReleaseV3BrowserSnapshot) | ConvertTo-Json -Depth 30 -Compress)){throw 'RELEASE_BROWSER_CONTINUITY_FAILED'}
}
