# All lifecycle effects are broker-owned operations. Tests supply inert/isolated operations.
function Invoke-ReleaseV3 {
    param([string]$Directory,[byte[]]$Key,$Broker,
        [ValidateSet('prepare','activate','rollback','recover','status')][string]$Operation,
        [string]$RequestId,$Candidate,$Previous,$Operations,[string]$CorrelationId='')
    $lock=Open-ReleaseV3Lock $Directory
    try {
        $path=Join-Path $Directory 'transaction.json'; $selectedPath=Join-Path $Directory 'selected.json'
        $state=if(Test-Path -LiteralPath $path){Read-ReleaseV3Signed $path $Key}else{$null}
        if($state){Test-ReleaseV3Receipts $state $Key}
        $eventRequest=if($CorrelationId){$CorrelationId}elseif($RequestId){$RequestId}else{[guid]::NewGuid().ToString('N')}
        if($eventRequest -cnotmatch '^[0-9a-f]{32}$'){throw 'RELEASE_CORRELATION_INVALID'}
        if($state){$state.event_request=$eventRequest}
        if($Operation -eq 'status'){if($state){return $state}else{return @{phase='NO_TRANSACTION'}}}
        if($Operation -eq 'prepare'){
            if($RequestId -notmatch '^[0-9a-f]{32}$'){throw 'RELEASE_REQUEST_ID_INVALID'}
            if($state -and $state.id -ceq $RequestId){
                if($state.candidate.entry -cne $Candidate.entry -or $state.candidate.sha -cne $Candidate.sha){throw 'RELEASE_REPLAY_CONFLICT'}
                return $state
            }
            if($state -and $state.phase -notin @('COMMITTED','ROLLED_BACK','ABORTED')){throw 'RELEASE_TRANSACTION_PENDING'}
            if(Test-Path -LiteralPath (Join-Path $Directory ($RequestId+'.json'))){throw 'RELEASE_REQUEST_REPLAY'}
            if($state){Write-ReleaseV3Signed (Join-Path $Directory ($state.id+'.json')) $state $Key}
            & $Operations.Validate $Candidate
            & $Operations.Validate $Previous
            $observation=& $Operations.Observe $Candidate $Previous $RequestId
            if($observation.kind -cne 'previous'){throw 'RELEASE_INCUMBENT_AMBIGUOUS'}
            & $Operations.Verify $Previous $observation.identity
            $priorSelection=if(Test-Path -LiteralPath $selectedPath){Read-ReleaseV3Signed $selectedPath $Key}else{$null}
            $state=@{schema=3;id=$RequestId;request=$RequestId;event_request=$eventRequest;phase='NEW';broker=$Broker;selection_before=$priorSelection;
                candidate=$Candidate;previous=$Previous;incumbent=$observation.identity;receipts=@()}
            Add-ReleaseV3Receipt $state 'PREPARED' $observation $path $Key $Broker
            return $state
        }
        if(-not $state){return @{phase='NO_TRANSACTION'}}
        if($Operation -in @('activate','rollback') -and $RequestId -cne $state.id){throw 'RELEASE_TRANSACTION_ID_MISMATCH'}
        if($Operation -eq 'rollback' -and $state.phase -eq 'ROLLED_BACK'){return $state}
        if($Operation -eq 'activate'){
            if($state.phase -eq 'COMMITTED'){return $state}
            if($state.phase -cne 'PREPARED'){throw 'RELEASE_ACTIVATION_REQUIRES_PREPARED'}
            if($state.broker.generation -cne $Broker.generation -or $state.broker.login_epoch -cne $Broker.login_epoch){throw 'RELEASE_STALE_BROKER'}
            # Gate failures precede STOPPING and do not trigger a replacement.
            & $Operations.Gate $state
            & $Operations.Validate $state.candidate
            & $Operations.Validate $state.previous
            $before=& $Operations.Observe $state.candidate $state.previous $state.id
            if($before.kind -cne 'previous' -or ($before.identity | ConvertTo-Json -Compress) -cne ($state.incumbent | ConvertTo-Json -Compress)){throw 'RELEASE_INCUMBENT_DRIFT'}
            Add-ReleaseV3Receipt $state 'STOPPING' $before $path $Key $Broker
            try {
                & $Operations.Stop $before.identity
                $after=& $Operations.Observe $state.candidate $state.previous $state.id
                if($after.kind -cne 'empty'){throw 'RELEASE_STOP_NOT_CONFIRMED'}
                Add-ReleaseV3Receipt $state 'STOPPED' $after $path $Key $Broker
                Add-ReleaseV3Receipt $state 'STARTING' $null $path $Key $Broker
                $started=& $Operations.Start $state.candidate $state.id
                Add-ReleaseV3Receipt $state 'VERIFYING' $started $path $Key $Broker
                & $Operations.Verify $state.candidate $started
                $current=& $Operations.Observe $state.candidate $state.previous $state.id
                if($current.kind -cne 'candidate' -or ($current.identity | ConvertTo-Json -Compress) -cne ($started | ConvertTo-Json -Compress)){throw 'RELEASE_CANDIDATE_DRIFT'}
                Add-ReleaseV3Receipt $state 'SELECTING' $current $path $Key $Broker
                Write-ReleaseV3Signed $selectedPath @{schema=3;transaction=$state.id;release=$state.candidate} $Key
                Add-ReleaseV3Receipt $state 'COMMITTED' $current $path $Key $Broker
                return $state
            } catch {
                # Persist only an error category; never leak runtime secrets or exception arguments.
                Add-ReleaseV3Receipt $state 'RECOVERY_REQUIRED' @{reason='ACTIVATION_FAILED'} $path $Key $Broker
            }
        }
        if($Operation -eq 'recover' -and $state.phase -in @('PREPARED','ABORTED','ROLLED_BACK')){return $state}
        if($Operation -eq 'recover' -and $state.phase -eq 'COMMITTED'){
            $selected=Read-ReleaseV3Signed $selectedPath $Key
            if($selected.transaction -cne $state.id -or $selected.release.entry -cne $state.candidate.entry){throw 'RELEASE_SELECTION_AMBIGUOUS'}
            return $state
        }
        # Any interrupted mutation converges to the known previous release, never to a guessed commit.
        & $Operations.Validate $state.previous
        Add-ReleaseV3Receipt $state 'ROLLING_BACK' $null $path $Key $Broker
        try {
            $observed=& $Operations.Observe $state.candidate $state.previous $state.id
            if($observed.kind -eq 'foreign'){throw 'RELEASE_FOREIGN_PROCESS'}
            $incumbentRetained=$observed.kind -eq 'previous' -and ($observed.identity | ConvertTo-Json -Compress) -ceq ($state.incumbent | ConvertTo-Json -Compress)
            if($observed.kind -eq 'candidate'){
                & $Operations.Stop $observed.identity
                $observed=& $Operations.Observe $state.candidate $state.previous $state.id
                if($observed.kind -cne 'empty'){throw 'RELEASE_ROLLBACK_STOP_NOT_CONFIRMED'}
            }
            $restored=if($observed.kind -eq 'previous'){$observed.identity}else{& $Operations.Start $state.previous ($state.id+'-rollback')}
            & $Operations.Verify $state.previous $restored
            $observed=& $Operations.Observe $state.candidate $state.previous $state.id
            if($observed.kind -cne 'previous'){throw 'RELEASE_ROLLBACK_IDENTITY_MISMATCH'}
            if($incumbentRetained){
                if($state.selection_before){Write-ReleaseV3Signed $selectedPath $state.selection_before $Key}
                elseif(Test-Path -LiteralPath $selectedPath){throw 'RELEASE_SELECTION_AMBIGUOUS'}
            } else {Write-ReleaseV3Signed $selectedPath @{schema=3;transaction=$state.id;release=$state.previous} $Key}
            Add-ReleaseV3Receipt $state 'ROLLED_BACK' $observed $path $Key $Broker
        } catch {
            Add-ReleaseV3Receipt $state 'RECOVERY_REQUIRED' @{reason='ROLLBACK_FAILED_OR_AMBIGUOUS'} $path $Key $Broker
        }
        return $state
    } finally {$lock.Dispose()}
}
