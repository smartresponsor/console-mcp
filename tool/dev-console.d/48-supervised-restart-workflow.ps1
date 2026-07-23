function Invoke-RestartAllSupervised {
    param([Parameter(Mandatory = $true)][ValidateSet('soft', 'warm', 'cold')][string]$Mode)

    $preflight = Invoke-WatchdogPreflight -Purpose "restart-all-$Mode"
    Invoke-StackSnapshot -Purpose "restart-all-$Mode-before" | Out-Null
    $generation = New-RestartGeneration
    $expectedTools = Get-DefaultExpectedSurface
    Save-ExpectedSurface -ToolNames $expectedTools | Out-Null
    Write-RestartState -Generation $generation -Status 'BUILDING' -Mode $Mode -Scope 'all' -Detail @{ expected_tools = $expectedTools } | Out-Null

    try {
        if ($Mode -eq 'cold') { Invoke-ColdRestartPreparation | Out-Null }
        if ($Mode -in @('warm', 'cold')) { Ensure-BuildOutput | Out-Null }

        Write-RestartState -Generation $generation -Status 'RESTARTING_LOCAL_SERVICES' -Mode $Mode -Scope 'all' | Out-Null
        $chatgpt = Invoke-ManagedRestart -Kind 'chatgpt' -Mode $Mode -ExpectedTools @()
        $codex = Invoke-ManagedRestart -Kind 'codex' -Mode $Mode -ExpectedTools $expectedTools

        Write-RestartState -Generation $generation -Status 'REVERIFYING_LOCAL_CHATGPT' -Mode $Mode -Scope 'all' -Detail @{ chatgpt = $chatgpt; codex = $codex } | Out-Null
        $chatgpt = Invoke-ManagedRestart -Kind 'chatgpt' -Mode 'soft' -ExpectedTools @()
        $authRuntime = Assert-AuthRuntimePostcondition -Kind 'chatgpt'

        Write-RestartState -Generation $generation -Status 'WAITING_PUBLIC_READY' -Mode $Mode -Scope 'all' -Detail @{ chatgpt = $chatgpt; codex = $codex; auth_runtime = $authRuntime } | Out-Null
        $tunnelState = Get-ManagedProcessState -Spec (Get-TunnelSpec)
        if (-not $tunnelState.running) {
            Start-Tunnel | Out-Null
        } elseif ($Mode -eq 'cold') {
            Stop-Tunnel | Out-Null
            Start-Tunnel | Out-Null
        }
        $public = Wait-PublicSmokeReady
        $authRuntime = Assert-AuthRuntimePostcondition -Kind 'chatgpt' -RequirePublic

        Write-RestartState -Generation $generation -Status 'VERIFYING_BROWSER_POSTCONDITION' -Mode $Mode -Scope 'all' -Detail @{ public = $public; auth_runtime = $authRuntime } | Out-Null
        $browserPostcondition = Invoke-BrowserFreshPostcondition -Purpose "restart-all-$Mode"

        $refresh = Invoke-ChatgptConnectorRefresh -Startup | ConvertFrom-Json
        $readyStatus = if ($refresh.ok -ne $true) { 'READY_SCHEMA_PROPAGATION_UNCONFIRMED' } elseif ($browserPostcondition.ok -eq $true) { 'READY' } else { 'READY_BROWSER_NOT_READY' }

        $ready = [pscustomobject]@{ ok = [bool]($refresh.ok -eq $true); generation = $generation; mode = $Mode; status = $readyStatus; chatgpt = $chatgpt; codex = $codex; public = $public; browser = $browserPostcondition; connector_refresh = $refresh }
        Write-RestartState -Generation $generation -Status $readyStatus -Mode $Mode -Scope 'all' -Detail $ready | Out-Null
        Write-ServerLaunchWatchdogState -Status "SERVER_LAUNCH_$readyStatus" -Detail $ready | Out-Null
        New-ServerLifecycleLaunchPrompt -Operation 'restart-all' -Generation $generation -Mode $Mode -Status $readyStatus -Detail $ready | Out-Null
        Invoke-StackSnapshot -Purpose "restart-all-$Mode-after-$readyStatus" | Out-Null
        return ($ready | ConvertTo-Json -Depth 30)
    } catch {
        $message = Sanitize-Text $_.Exception.Message
        Write-RestartState -Generation $generation -Status 'FAILED' -Mode $Mode -Scope 'all' -ErrorMessage $message | Out-Null
        throw $message
    }
}

function Invoke-SingleServiceSupervisedRestart {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('chatgpt', 'codex')][string]$Kind,
        [Parameter(Mandatory = $true)][ValidateSet('soft', 'warm', 'cold')][string]$Mode
    )

    $preflight = $null
    if ($Kind -eq 'chatgpt') {
        $preflight = Invoke-WatchdogPreflight -Purpose "restart-$Kind-$Mode"
        Invoke-StackSnapshot -Purpose "restart-$Kind-$Mode-before" | Out-Null
    }
    $generation = New-RestartGeneration
    $expectedTools = Get-DefaultExpectedSurface
    Save-ExpectedSurface -ToolNames $expectedTools | Out-Null
    Write-RestartState -Generation $generation -Status 'RESTARTING_LOCAL_SERVICE' -Mode $Mode -Scope $Kind | Out-Null

    try {
        $result = Invoke-ManagedRestart -Kind $Kind -Mode $Mode -ExpectedTools $expectedTools
        $connectorRefresh = $null
        if ($Kind -eq 'chatgpt') {
            $connectorRefresh = Invoke-ChatgptConnectorRefresh -Startup | ConvertFrom-Json
        }
        $connectorRefreshAcceptable = [bool]($Kind -ne 'chatgpt' -or (Test-ChatgptConnectorRefreshAcceptable -Result $connectorRefresh))
        $readyStatus = if ($Kind -eq 'chatgpt' -and $connectorRefresh.status -eq 'CONNECTOR_REFRESH_UI_CONFIRMED_SCHEMA_PENDING') { 'READY_SCHEMA_PROPAGATION_PENDING' } elseif (-not $connectorRefreshAcceptable) { 'READY_SCHEMA_PROPAGATION_UNCONFIRMED' } else { 'READY' }
        $ready = [pscustomobject]@{ ok = $connectorRefreshAcceptable; generation = $generation; mode = $Mode; scope = $Kind; status = $readyStatus; service = $result; connector_refresh = $connectorRefresh; expected_tools = $expectedTools }
        Write-RestartState -Generation $generation -Status $readyStatus -Mode $Mode -Scope $Kind -Detail $ready | Out-Null
        Write-ServerLaunchWatchdogState -Status "SERVER_LAUNCH_$readyStatus" -Detail $ready | Out-Null
        if ($Kind -eq 'chatgpt') {
            Invoke-StackSnapshot -Purpose "restart-$Kind-$Mode-after-$readyStatus" | Out-Null
        }
        return ($ready | ConvertTo-Json -Depth 30)
    } catch {
        $message = Sanitize-Text $_.Exception.Message
        Write-RestartState -Generation $generation -Status 'FAILED' -Mode $Mode -Scope $Kind -ErrorMessage $message | Out-Null
        throw $message
    }
}

