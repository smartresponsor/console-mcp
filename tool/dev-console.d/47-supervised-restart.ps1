function Save-ExpectedSurface {
    param([string[]]$ToolNames)

    Ensure-Directories
    $payload = [pscustomobject]@{
        generated_at = (Get-Date).ToString('o')
        tool_names = @($ToolNames | Sort-Object -Unique)
    }
    $payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ExpectedSurfaceFile -Encoding utf8
    return $payload
}

function Invoke-ColdRestartPreparation {
    $npm = Get-NpmCommand
    Push-Location $Root
    try {
        $output = & $npm install 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }

    if ($exitCode -ne 0) {
        $message = Sanitize-Text (($output | Out-String).Trim())
        throw "npm install failed during cold restart preparation. $message"
    }

    return [pscustomobject]@{ ok = $true; command = 'npm install' }
}

function Test-ExpectedToolsFromSmoke {
    param([object]$Smoke, [string[]]$ExpectedTools = @())

    $expected = @($ExpectedTools | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique)
    if ($expected.Count -eq 0) {
        return [pscustomobject]@{ ok = $true; skipped = $true; reason = 'no expected tools configured'; expected = @(); missing = @() }
    }

    $available = @()
    if ($Smoke -and $Smoke.PSObject.Properties.Name -contains 'list_tools') {
        $available = @($Smoke.list_tools)
    }

    $comparison = Compare-ToolSurface -ExpectedTools $expected -RuntimeTools $available
    $readinessOk = $comparison.missing_count -eq 0
    return [pscustomobject]@{
        ok = $readinessOk
        skipped = $false
        source = 'authenticated MCP tool list'
        readiness_status = if ($readinessOk) { 'EXPECTED_TOOLS_PRESENT' } else { 'EXPECTED_TOOLS_MISSING' }
        expected = $expected
        runtime = @($available | Sort-Object -Unique)
        comparison = $comparison
    }
}

function Wait-ManagedServiceReady {
    param(
        [Parameter(Mandatory = $true)]$Spec,
        [Parameter(Mandatory = $true)][string]$Origin,
        [Parameter(Mandatory = $true)][ValidateSet('chatgpt', 'codex')][string]$Kind,
        [string[]]$ExpectedTools = @(),
        [int]$TimeoutSeconds = 45,
        [int]$IntervalMilliseconds = 500
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $last = $null
    while ((Get-Date) -lt $deadline) {
        $state = Get-ManagedProcessState -Spec $Spec
        if ($state.running -and $state.port_open) {
            if ($Kind -eq 'chatgpt') {
                $last = Invoke-ChatgptSmoke -Origin $Origin -Label 'local-chatgpt' -Quiet
                if ($last.ok -eq $true) {
                    return [pscustomobject]@{
                        ok = $true
                        process = $state
                        smoke = $last
                        expected_tools = [pscustomobject]@{ skipped = $true; reason = 'oauth profile readiness is transport-level; authenticated surface is checked through codex profile' }
                    }
                }
            } else {
                $last = Invoke-CodexSmoke -Origin $Origin -Label 'local-codex' -Quiet
                if ($last.ok -eq $true) {
                    $toolCheck = Test-ExpectedToolsFromSmoke -Smoke $last.authenticated_smoke -ExpectedTools $ExpectedTools
                    if ($toolCheck.ok -eq $true) {
                        return [pscustomobject]@{ ok = $true; process = $state; smoke = $last; expected_tools = $toolCheck }
                    }
                }
            }
        } else {
            $last = [pscustomobject]@{ ok = $false; reason = 'process-not-ready'; process = $state }
        }

        Start-Sleep -Milliseconds $IntervalMilliseconds
    }

    throw ("{0} did not become ready within {1} seconds. Last result: {2}" -f $Spec.Name, $TimeoutSeconds, (($last | ConvertTo-Json -Depth 20 -Compress)))
}

function Invoke-ManagedRestart {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('chatgpt', 'codex')][string]$Kind,
        [Parameter(Mandatory = $true)][ValidateSet('soft', 'warm', 'cold')][string]$Mode,
        [string[]]$ExpectedTools = @()
    )

    $spec = if ($Kind -eq 'chatgpt') { Get-ChatgptSpec } else { Get-CodexSpec }
    $origin = if ($Kind -eq 'chatgpt') { $ChatgptOrigin } else { $CodexOrigin }
    $start = if ($Kind -eq 'chatgpt') { { Start-ChatgptOauth | Out-Null } } else { { Start-CodexBearer | Out-Null } }
    $stop = if ($Kind -eq 'chatgpt') { { Stop-ChatgptOauth | Out-Null } } else { { Stop-CodexBearer | Out-Null } }

    if ($Mode -eq 'cold') { Invoke-ColdRestartPreparation | Out-Null }

    if ($Mode -in @('warm', 'cold')) {
        Ensure-BuildOutput | Out-Null
        & $stop
        & $start
    } else {
        $state = Get-ManagedProcessState -Spec $spec
        if (-not $state.running) { & $start }
    }

    return Wait-ManagedServiceReady -Spec $spec -Origin $origin -Kind $Kind -ExpectedTools $ExpectedTools
}

