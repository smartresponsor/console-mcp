# Central read-only runtime -> immutable release provenance.
# This capability never activates, restarts, repairs, writes authority state, or changes mounts.
function Invoke-RuntimeReleaseReadOnlyCommand {
    param([Parameter(Mandatory=$true)][string]$Name,[string[]]$Arguments=@())
    $command=Get-Command $Name -ErrorAction Stop
    $output=@(& $command.Source @Arguments 2>$null)
    if($LASTEXITCODE -ne 0){throw ($Name.ToUpperInvariant()+'_FAILED')}
    return ($output -join [Environment]::NewLine).Trim()
}
function Get-RuntimeReleaseManifestEvidence {
    param([Parameter(Mandatory=$true)][string]$ReleaseRoot)
    $manifestPath=Join-Path $ReleaseRoot 'release.json'
    if(-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)){return [pscustomobject]@{status='MANIFEST_MISSING';source_commit=$null;build_fingerprint=$null;inventory_verified=$false}}
    try {
        $manifest=Get-Content -LiteralPath $manifestPath -Raw -ErrorAction Stop | ConvertFrom-Json
        $expected=$manifest.files
        if($null -eq $expected){throw 'MANIFEST_FILE_INVENTORY_MISSING'}
        $expectedNames=@($expected.PSObject.Properties | ForEach-Object {$_.Name})
        $expectedCount=$expectedNames.Count
        $actual=[ordered]@{}
        foreach($item in @(Get-ChildItem -LiteralPath $ReleaseRoot -Recurse -Force -File -ErrorAction Stop)){
            if($item.FullName -ceq $manifestPath){continue}
            $relative=[IO.Path]::GetRelativePath($ReleaseRoot,$item.FullName).Replace('\','/')
            if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){
                $target=[string]$item.LinkTarget
                if([string]::IsNullOrWhiteSpace($target)){throw 'RELEASE_LINK_TARGET_UNAVAILABLE'}
                $actual[$relative]='link:'+$target
            } else {$actual[$relative]=(Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()}
        }
        $inventoryOk=$actual.Count -eq $expectedCount
        if($inventoryOk){foreach($name in $expectedNames){if(-not $actual.Contains($name) -or $actual[$name] -cne [string]$expected.$name){$inventoryOk=$false;break}}}
        return [pscustomobject]@{status=if($inventoryOk){'MANIFEST_VERIFIED'}else{'MANIFEST_DRIFT'};source_commit=[string]$manifest.sourceCommit;build_fingerprint=[string]$manifest.buildFingerprint;inventory_verified=[bool]$inventoryOk;expected_file_count=$expectedCount;actual_file_count=$actual.Count}
    } catch {return [pscustomobject]@{status='MANIFEST_UNREADABLE';source_commit=$null;build_fingerprint=$null;inventory_verified=$false;error=$_.Exception.Message}}
}
function Get-UbuntuRuntimeReleaseProvenance {
    $service='console-mcp.service'
    $pidText=Invoke-RuntimeReleaseReadOnlyCommand -Name 'systemctl' -Arguments @('show',$service,'--property=MainPID','--value')
    $pidValue=0
    if(-not [int]::TryParse($pidText,[ref]$pidValue) -or $pidValue -le 0){throw 'RUNTIME_SERVICE_MAIN_PID_UNAVAILABLE'}
    $proc="/proc/$pidValue"
    if(-not (Test-Path -LiteralPath $proc)){throw 'RUNTIME_PROCESS_PROC_ENTRY_MISSING'}
    $executable=[string](Get-Item -LiteralPath (Join-Path $proc 'exe') -ErrorAction Stop).Target
    $cwd=[string](Get-Item -LiteralPath (Join-Path $proc 'cwd') -ErrorAction Stop).Target
    $argv=@([Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes((Join-Path $proc 'cmdline'))).Split([char]0) | Where-Object {$_})
    $commandHasNode=[bool](@($argv | Where-Object {$_ -match '(^|/)node(js)?$'}).Count -gt 0)
    $entrypointArgument=[string](@($argv | Where-Object {$_ -match 'dist[/\\]index\.js$'} | Select-Object -First 1)[0])
    $processEntrypoint=[bool]($commandHasNode -and $entrypointArgument)
    $command=$argv -join ' '
    $binds=Invoke-RuntimeReleaseReadOnlyCommand -Name 'systemctl' -Arguments @('show',$service,'--property=BindReadOnlyPaths','--value')
    $fragment=Invoke-RuntimeReleaseReadOnlyCommand -Name 'systemctl' -Arguments @('show',$service,'--property=FragmentPath','--value')
    $dropIns=Invoke-RuntimeReleaseReadOnlyCommand -Name 'systemctl' -Arguments @('show',$service,'--property=DropInPaths','--value')
    $live='/home/alex/smartresponse/mcp/console-mcp';$sources=@()
    foreach($binding in @($binds -split '\s+' | Where-Object {$_ -match '^/' -and $_.Contains(':')})){
        $parts=$binding.Split(':',2)
        if($parts.Count -eq 2 -and $parts[1].StartsWith($live+'/',[StringComparison]::Ordinal)){$sources += [pscustomobject]@{source=$parts[0];target=$parts[1]}}
    }
    $releaseRoots=@($sources | ForEach-Object {if($_.source -match '^(.*?/releases/[^/]+)/(.+)$'){$Matches[1]}} | Where-Object {$_} | Select-Object -Unique)
    $registryPath='/opt/console-mcp-deploy/registry.json';$transactionPath='/opt/console-mcp-deploy/transaction.json'
    $registry=$null;$transaction=$null;$registryStatus='UNREADABLE'
    try {$registry=Get-Content -LiteralPath $registryPath -Raw -ErrorAction Stop | ConvertFrom-Json;$registryStatus='READABLE'} catch {$registryStatus=if(Test-Path -LiteralPath $registryPath){'ACCESS_DENIED_OR_INVALID'}else{'MISSING'}}
    try {if(Test-Path -LiteralPath $transactionPath){$transaction=Get-Content -LiteralPath $transactionPath -Raw -ErrorAction Stop | ConvertFrom-Json}} catch {$transaction=$null}
    $releaseRoot=if($releaseRoots.Count -eq 1){$releaseRoots[0]}else{$null}
    $manifest=if($releaseRoot){Get-RuntimeReleaseManifestEvidence -ReleaseRoot $releaseRoot}else{$null}
    $releaseId=if($releaseRoot){Split-Path -Leaf $releaseRoot}else{$null}
    $rollbackRoot=if($registry -and $registry.rollback){Join-Path '/opt/console-mcp-deploy/releases' ([string]$registry.rollback)}else{$null}
    $rollbackManifest=if($rollbackRoot -and (Test-Path -LiteralPath $rollbackRoot -PathType Container)){Get-RuntimeReleaseManifestEvidence -ReleaseRoot $rollbackRoot}else{$null}
    $sourceMatches=[bool]($registry -and $manifest -and $manifest.source_commit -and $registry.sourceSHA -ceq $manifest.source_commit)
    $activeMatches=[bool]($registry -and $releaseId -and $registry.candidate -ceq $releaseId)
    # Entrypoint is derived from argv without persisting the raw command line.
    $processEntrypoint=[bool]($commandHasNode -and $entrypointArgument)
    $rollbackVerified=[bool]($rollbackManifest -and $rollbackManifest.inventory_verified)
    return [pscustomobject]@{
        schema_version=1;platform='ubuntu';observed_at=[datetimeoffset]::UtcNow.ToString('o')
        status=if($releaseRoot -and $manifest.inventory_verified -and $sourceMatches -and $activeMatches -and $processEntrypoint -and $rollbackVerified){'RELEASE_PROVENANCE_VERIFIED'}else{'RELEASE_PROVENANCE_INCOMPLETE'}
        process=[pscustomobject]@{pid=$pidValue;executable=$executable;cwd=$cwd;entrypoint_observed=$processEntrypoint;entrypoint_argument=$entrypointArgument;command_line_persisted=$false}
        service=[pscustomobject]@{name=$service;fragment_path=$fragment;drop_in_paths=$dropIns;bind_read_only_paths=$sources}
        release=[pscustomobject]@{id=$releaseId;root=$releaseRoot;source_commit=if($manifest){$manifest.source_commit}else{$null};build_fingerprint=if($manifest){$manifest.build_fingerprint}else{$null};manifest_status=if($manifest){$manifest.status}else{'NOT_RESOLVED'};manifest_inventory_verified=if($manifest){$manifest.inventory_verified}else{$false};registry_candidate=if($registry){$registry.candidate}else{$null};registry_rollback=if($registry){$registry.rollback}else{$null};registry_source_sha=if($registry){$registry.sourceSHA}else{$null};registry_status=$registryStatus;registry_matches_mounted_release=$activeMatches;source_sha_matches_manifest=$sourceMatches;manifest_error=if($manifest -and $manifest.error){$manifest.error}else{$null};rollback_manifest_status=if($rollbackManifest){$rollbackManifest.status}else{'NOT_RESOLVED'};rollback_manifest_inventory_verified=if($rollbackManifest){$rollbackManifest.inventory_verified}else{$false};rollback_source_commit=if($rollbackManifest){$rollbackManifest.source_commit}else{$null}}
        transaction=[pscustomobject]@{phase=if($transaction){$transaction.phase}else{'NOT_FOUND'};candidate=if($transaction){$transaction.candidate}else{$null};rollback=if($transaction){$transaction.rollback}else{$null}}
        evidence=[pscustomobject]@{mount_source_count=$sources.Count;release_root_count=$releaseRoots.Count;release_root_ambiguous=($releaseRoots.Count -gt 1)}
        mutation_performed=$false
    }
}
function Get-WindowsRuntimeReleaseProvenance {
    $authority=Get-ReleaseV3Directory;$selected=$null;$selectionStatus='UNAVAILABLE'
    try {$selected=Get-ReleaseV3Selected;$selectionStatus=if($selected){'AUTHENTICATED_SELECTION_READ'}else{'NO_SELECTION'}} catch {$selectionStatus=$_.Exception.Message}
    $identity=$null;$listenerPid=$null
    foreach($port in @(3333,3334,3335)){try {$listener=Get-ListeningProcessOnPort -Port $port;if($listener){$listenerPid=[int]$listener.OwningProcess;break}}catch{}}
    if($listenerPid){try {$identity=Get-ReleaseV3ProcessIdentity -ProcessId $listenerPid}catch{}}
    $descriptorStatus='NOT_RESOLVED';$selectedRoot=$null;$selectedSha=$null;$selectedEntry=$null;$launchId=$null
    if($selected){
        $selectedRoot=[string]$selected.root;$selectedSha=[string]$selected.sha;$selectedEntry=[string]$selected.entry;$launchId=[string]$selected.launch_id
        try {Test-ReleaseV3Descriptor -Descriptor $selected;$descriptorStatus='PAYLOAD_HASHES_VERIFIED'}catch{$descriptorStatus=$_.Exception.Message}
    }
    $processMatches=[bool]($identity -and $selectedEntry -and $identity.command.Contains($selectedEntry) -and $launchId -and $identity.command.Contains('--console-release-transaction='+$launchId))
    $sourceMatches=[bool]($selectedSha -match '^[0-9a-f]{40}$')
    return [pscustomobject]@{
        schema_version=1;platform='windows';observed_at=[datetimeoffset]::UtcNow.ToString('o')
        status=if($selectionStatus -eq 'AUTHENTICATED_SELECTION_READ' -and $descriptorStatus -eq 'PAYLOAD_HASHES_VERIFIED' -and $sourceMatches -and $processMatches){'RELEASE_PROVENANCE_VERIFIED'}else{'RELEASE_PROVENANCE_INCOMPLETE'}
        process=[pscustomobject]@{pid=if($identity){$identity.pid}else{$listenerPid};started_at=if($identity){$identity.started}else{$null};executable=if($identity){$identity.executable}else{$null};session=if($identity){$identity.session}else{$null};entrypoint_matches_selected=$processMatches;command_line_persisted=$false}
        authority=[pscustomobject]@{directory=$authority;selection_status=$selectionStatus;selection_authenticated=($selectionStatus -eq 'AUTHENTICATED_SELECTION_READ')}
        release=[pscustomobject]@{id=$selectedSha;root=$selectedRoot;entrypoint=$selectedEntry;source_commit=$selectedSha;build_fingerprint=$null;manifest_status='SIGNED_DESCRIPTOR_NOT_SEPARATE_MANIFEST';manifest_inventory_verified=($descriptorStatus -eq 'PAYLOAD_HASHES_VERIFIED');payload_status=$descriptorStatus;source_sha_valid=$sourceMatches}
        transaction=[pscustomobject]@{launch_id=$launchId}
        mutation_performed=$false
    }
}
function Get-RuntimeReleaseProvenance {
    if($IsLinux){return Get-UbuntuRuntimeReleaseProvenance}
    if($IsWindows){return Get-WindowsRuntimeReleaseProvenance}
    return [pscustomobject]@{schema_version=1;platform='unsupported';status='RELEASE_PROVENANCE_UNSUPPORTED';mutation_performed=$false}
}
