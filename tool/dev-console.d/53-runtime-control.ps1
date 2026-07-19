function Show-Status {
    $chatgptState = Get-ManagedProcessState -Spec (Get-ChatgptSpec)
    $codexState = Get-ManagedProcessState -Spec (Get-CodexSpec)
    $tunnelState = Get-ManagedProcessState -Spec (Get-TunnelSpec)
    $bearerSecret = Get-ConsoleBearerTokenStatus
    $localChatgptSmoke = Invoke-ChatgptSmoke -Origin $ChatgptOrigin -Label 'local-chatgpt' -Quiet
    $localCodexSmoke = Invoke-CodexSmoke -Origin $CodexOrigin -Label 'local-codex' -Quiet
    $publicSmoke = Invoke-ChatgptSmoke -Origin $PublicOrigin -Label 'public' -Quiet

    [pscustomobject]@{
        chatgpt_oauth = $chatgptState
        codex_bearer = $codexState
        codex_bearer_secret = $bearerSecret
        tunnel = $tunnelState
        build_output = Get-BuildOutputReport
        tailscale = Get-TailscaleReport
        autostart = Get-AutostartSummary
        chatgpt_connector_refresh = Get-ChatgptConnectorRefreshState
        restart = Get-RestartState
        smoke = [pscustomobject]@{
            local_chatgpt = $localChatgptSmoke
            local_codex = $localCodexSmoke
            public = $publicSmoke
        }
    } | ConvertTo-Json -Depth 10
}

function Start-UnifiedConsoleRuntime {
    Ensure-BuildOutput | Out-Null
    $tokenResolution = Get-ConfiguredSecretValue -Name 'CONSOLE_MCP_BEARER_TOKEN' -WithSource
    $token = [string]$tokenResolution.value
    if ([string]::IsNullOrWhiteSpace($token)) {
        throw "CONSOLE_MCP_BEARER_TOKEN must be set before starting the unified console-mcp runtime."
    }

    $spec = Get-ChatgptSpec
    $spec.Name = 'unified-runtime'
    $spec.Environment['CONSOLE_MCP_AUTH_MODE'] = ''
    $spec.Environment['CONSOLE_MCP_MANAGED_RUNTIME'] = 'watchdog-session-relay'
    $spec.LogFile = Join-Path $LogDir 'console-mcp-unified.log'
    $spec.RequiresBearerToken = $true
    $spec.Environment['CONSOLE_MCP_BEARER_TOKEN'] = $token.Trim()
    $spec.Environment['CONSOLE_MCP_BEARER_TOKEN_SOURCE'] = [string]$tokenResolution.source

    $chatgptState = Get-ManagedProcessState -Spec (Get-ChatgptSpec)
    $codexState = Get-ManagedProcessState -Spec (Get-CodexSpec)
    $sharedPid = $chatgptState.pid -and $codexState.pid -and ([int]$chatgptState.pid -eq [int]$codexState.pid)
    $runtimeCurrent = $chatgptState.runtime_state -eq 'current' -and $codexState.runtime_state -eq 'current'
    if ($chatgptState.running -and $chatgptState.port_open -and $codexState.running -and $codexState.port_open -and $sharedPid -and $runtimeCurrent) {
        return ($chatgptState | ConvertTo-Json -Depth 10)
    }
    if ($chatgptState.running -or $codexState.running -or $chatgptState.port_open -or $codexState.port_open) {
        Stop-UnifiedConsoleRuntime | Out-Null
    }

    # $spec is cloned from Get-ChatgptSpec, so $spec.Port is always 3333 - Start-ManagedProcess's
    # own Wait-ForPortOpen only ever confirms the ChatGPT/OAuth port. That let this function return
    # "ready" while the Codex/Bearer port (3334) had not opened yet at all - the real single
    # process serves both, so readiness has to mean both, not whichever port the cloned spec
    # happens to carry. Explicitly wait on the Codex port too before declaring the runtime started.
    Start-ManagedProcess -Spec $spec -FilePath (Get-NodeCommand).Source -Arguments @('--enable-source-maps', (Join-Path $Root 'dist/index.js')) | Out-Null
    Wait-ForPortOpen -Port (Get-CodexSpec).Port -TimeoutSeconds 30
    return (Get-ManagedProcessState -Spec (Get-ChatgptSpec) | ConvertTo-Json -Depth 10)
}

function Stop-UnifiedConsoleRuntime {
    Stop-ManagedProcess -Spec (Get-ChatgptSpec)
}

function Start-ChatgptOauth {
    Start-UnifiedConsoleRuntime
}

function Stop-ChatgptOauth {
    Stop-UnifiedConsoleRuntime
}

function Start-CodexBearer {
    Start-UnifiedConsoleRuntime
}

function Stop-CodexBearer {
    Stop-UnifiedConsoleRuntime
}

function Start-Tunnel {
    Ensure-Directories
    if (-not (Test-Path -LiteralPath $CloudflaredConfig)) {
        throw "cloudflared config not found at $CloudflaredConfig."
    }

    Check-Cloudflared -FailOnMissing | Out-Null

    $spec = Get-TunnelSpec
    $cloudflared = Resolve-CloudflaredExe
    $result = Start-ManagedProcess -Spec $spec -FilePath $cloudflared -Arguments @('tunnel', '--config', $CloudflaredConfig, 'run', 'console-mcp')
    Wait-PublicSmokeReady | Out-Null
    return $result
}

function Stop-Tunnel {
    Stop-ManagedProcess -Spec (Get-TunnelSpec)
}

function Stop-ServerForWatchdogRecovery {
    # See tool/dev-console.d/90-server-lifecycle.ps1 for the authoritative process discovery,
    # confirmed-kill, and post-stop verification this delegates to. Unlike the previous
    # fire-and-forget implementation, this can no longer report success while an old server PID is
    # still alive: Invoke-ConsoleServerConfirmedStop only returns ok=$true once the old PIDs are
    # confirmed dead, their ports are released, the watchdog has been resumed exactly once, and a
    # replacement process with a different PID is healthy on both endpoints.
    $result = Invoke-ConsoleServerConfirmedStop
    $json = $result | ConvertTo-Json -Depth 30
    Write-Output $json
    if (-not $result.ok) {
        exit 1
    }
}
