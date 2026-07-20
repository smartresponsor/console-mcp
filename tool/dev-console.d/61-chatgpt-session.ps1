function ConvertTo-SafeBrowserAutomationOutput {
    param([object]$Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [string]) {
        if ($Value.Contains('client-bootstrap')) { return '[redacted]' }
        return $Value
    }
    if ($Value -is [ValueType]) { return $Value }
    if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string]) -and -not ($Value -is [System.Collections.IDictionary])) {
        $items = @()
        foreach ($item in $Value) { $items += ConvertTo-SafeBrowserAutomationOutput -Value $item }
        Write-Output -NoEnumerate ([object[]]$items)
        return
    }

    $names = if ($Value -is [System.Collections.IDictionary]) { @($Value.Keys) } else { @($Value.PSObject.Properties.Name) }
    $hasTargetShape = ($names -contains 'id' -or $names -contains 'targetId') -and ($names -contains 'type' -or $names -contains 'url') -and ($names -contains 'webSocketDebuggerUrl' -or $names -contains 'web_socket_debugger_url' -or $names -contains 'devtoolsFrontendUrl' -or $names -contains 'devtools_frontend_url' -or $names -contains 'chat_id')
    if ($hasTargetShape) {
        return [pscustomobject]@{
            port = Get-ObjectPropertyValue -Value $Value -Name 'port'
            id = if (Get-ObjectPropertyValue -Value $Value -Name 'id') { Get-ObjectPropertyValue -Value $Value -Name 'id' } else { Get-ObjectPropertyValue -Value $Value -Name 'targetId' }
            type = Get-ObjectPropertyValue -Value $Value -Name 'type'
            title = Get-ObjectPropertyValue -Value $Value -Name 'title'
            url = Get-ObjectPropertyValue -Value $Value -Name 'url'
            chat_id = Get-ObjectPropertyValue -Value $Value -Name 'chat_id'
            has_web_socket_debugger_url = [bool]((Get-ObjectPropertyValue -Value $Value -Name 'has_web_socket_debugger_url') -or (Get-ObjectPropertyValue -Value $Value -Name 'webSocketDebuggerUrl') -or (Get-ObjectPropertyValue -Value $Value -Name 'web_socket_debugger_url') -or (Get-ObjectPropertyValue -Value $Value -Name 'devtoolsFrontendUrl') -or (Get-ObjectPropertyValue -Value $Value -Name 'devtools_frontend_url'))
        }
    }

    $output = [ordered]@{}
    $nodeName = [string](Get-ObjectPropertyValue -Value $Value -Name 'nodeName')
    foreach ($name in $names) {
        $key = [string]$name
        $entryValue = Get-ObjectPropertyValue -Value $Value -Name $key
        if ($key -match '^(accessToken|sessionToken|id_token|refresh_token|authorization|cookie|set-cookie|webSocketDebuggerUrl|web_socket_debugger_url|devtoolsFrontendUrl|devtools_frontend_url)$') {
            $output[$key] = '[redacted]'
        } elseif ($key -match '^(domSnapshot|dom_snapshot|rawDom|raw_dom|outerHTML|innerHTML|documentHTML|document_html)$' -or ($nodeName.ToUpperInvariant() -eq 'SCRIPT' -and $key -eq 'nodeValue')) {
            $output[$key] = '[redacted]'
        } else {
            $preserveArrayShape = $key -in @('selected_target_candidates', 'candidate_rejections', 'signals', 'selectors', 'matches')
            if ($preserveArrayShape -and $null -eq $entryValue) {
                $output[$key] = $null
            } elseif ($entryValue -is [System.Collections.IEnumerable] -and -not ($entryValue -is [string]) -and -not ($entryValue -is [System.Collections.IDictionary])) {
                $items = @()
                foreach ($item in $entryValue) { $items += ConvertTo-SafeBrowserAutomationOutput -Value $item }
                $output[$key] = [object[]]$items
            } elseif ($preserveArrayShape) {
                $output[$key] = [object[]]@(ConvertTo-SafeBrowserAutomationOutput -Value $entryValue)
            } else {
                $output[$key] = ConvertTo-SafeBrowserAutomationOutput -Value $entryValue
            }
        }
    }
    return [pscustomobject]$output
}

function ConvertTo-SafeBrowserAutomationJson {
    param([object]$Value, [int]$Depth = 30)
    return (ConvertTo-SafeBrowserAutomationOutput -Value $Value | ConvertTo-Json -Depth $Depth)
}

function Invoke-ChatgptBrowserSessionCli {
    param(
        [Parameter(Mandatory = $true)][string]$CliCommand,
        [string[]]$Arguments = @()
    )
    Ensure-BuildOutput | Out-Null
    $node = Get-NodeCommand
    $scriptPath = Join-Path $Root 'dist\cli\chatgpt-browser-session-cli.js'
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        throw "ChatGPT browser session CLI is missing: $scriptPath"
    }
    Push-Location $Root
    try {
        & $node.Source --enable-source-maps $scriptPath $CliCommand @Arguments
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
    } finally {
        Pop-Location
    }
}

function Invoke-ChatgptSessionWarmth {
    Ensure-BuildOutput | Out-Null
    $node = Get-NodeCommand
    $scriptPath = Join-Path $Root 'dist\cli\chatgpt-browser-session-cli.js'
    $raw = & $node.Source --enable-source-maps $scriptPath chatgpt-session-warmth 2>&1
    if ($LASTEXITCODE -ne 0) {
        return [pscustomobject]@{ ok = $false; status = 'CHATGPT_SESSION_WARMTH_CHECK_FAILED'; error = Sanitize-Text (($raw | Out-String).Trim()); state_file = (Join-Path $RunDir 'chatgpt-session-warmth.json') }
    }
    return ($raw | Out-String | ConvertFrom-Json)
}

function Invoke-ChatgptSessionWarmthRepair {
    param([switch]$ConfirmRepair)

    Ensure-BuildOutput | Out-Null
    $node = Get-NodeCommand
    $scriptPath = Join-Path $Root 'dist\cli\chatgpt-browser-session-cli.js'
    $arguments = @('chatgpt-session-warmth-repair')
    if ($ConfirmRepair) {
        $arguments += '-ConfirmRepair'
    }
    $raw = & $node.Source --enable-source-maps $scriptPath @arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        $warmth = Invoke-ChatgptSessionWarmth
        return [pscustomobject]@{ ok = $false; status = 'CHATGPT_SESSION_WARMTH_REPAIR_FAILED'; error = Sanitize-Text (($raw | Out-String).Trim()); before_warmth = $warmth; repair_action = 'failed'; prune_result = $null; after_warmth = $warmth }
    }
    return ($raw | Out-String | ConvertFrom-Json)
}

function Get-ServerLifecycleLogTail {
    param([int]$MaxLines = 80)
    if (-not (Test-Path -LiteralPath $ServerLifecycleLogFile -PathType Leaf)) { return @() }
    return @(Get-Content -LiteralPath $ServerLifecycleLogFile -Tail $MaxLines -ErrorAction SilentlyContinue)
}

function Get-CompactGitLifecycleSummary {
    $head = $null
    $statusLines = @()
    Push-Location $Root
    try {
        $head = ((& git rev-parse --short HEAD 2>$null) | Select-Object -First 1)
        $statusLines = @(& git status --short 2>$null)
    } catch {
        $statusLines = @('git_status_unavailable')
    } finally {
        Pop-Location
    }
    return [pscustomobject]@{ head = if ($head) { [string]$head } else { $null }; dirty_count = @($statusLines).Count; status = @($statusLines | Select-Object -First 40) }
}

function Get-ServerLifecyclePromptSha256 {
    param([string]$PromptFile = $ServerLifecyclePromptFile)
    if ([string]::IsNullOrWhiteSpace($PromptFile) -or -not (Test-Path -LiteralPath $PromptFile -PathType Leaf)) { return $null }
    $stream = [System.IO.File]::OpenRead($PromptFile)
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            return [System.BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
        } finally {
            $sha.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

function Get-TextSha256 {
    param([string]$Text = '')
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        return [System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Get-ServerLifecycleSuggestedChatTitleFull {
    if (Test-Path -LiteralPath $ServerLifecyclePromptFile -PathType Leaf) {
        $text = Get-Content -LiteralPath $ServerLifecyclePromptFile -Raw
        $match = [regex]::Match($text, '(?m)^- suggested chat title:\s*(.+)$')
        if ($match.Success) { return $match.Groups[1].Value.Trim() }
    }
    return ('Console MCP Lifecycle Review ' + (Get-Date).ToString('yyyy-MM-dd HH:mm'))
}

function Get-ServerLifecycleId6 {
    param([string]$ChatId = $null, [string]$TargetId = $null)
    if (-not [string]::IsNullOrWhiteSpace($ChatId)) { return $ChatId.Trim().Substring(0, [Math]::Min(6, $ChatId.Trim().Length)) }
    if (-not [string]::IsNullOrWhiteSpace($TargetId)) { return $TargetId.Trim().Substring(0, [Math]::Min(6, $TargetId.Trim().Length)) }
    return 'none'
}

function Get-ServerLifecycleTitleIdSource {
    param([string]$ChatId = $null, [string]$TargetId = $null, [string]$PromptFile = $ServerLifecyclePromptFile)
    if (-not [string]::IsNullOrWhiteSpace($ChatId)) {
        return [pscustomobject]@{ source = 'chat_id'; value = $ChatId.Trim().Substring(0, [Math]::Min(6, $ChatId.Trim().Length)) }
    }
    if (-not [string]::IsNullOrWhiteSpace($TargetId)) {
        return [pscustomobject]@{ source = 'target_id'; value = $TargetId.Trim().Substring(0, [Math]::Min(6, $TargetId.Trim().Length)) }
    }
    $promptSha256 = Get-ServerLifecyclePromptSha256 -PromptFile $PromptFile
    if (-not [string]::IsNullOrWhiteSpace($promptSha256)) {
        return [pscustomobject]@{ source = 'prompt_sha256'; value = $promptSha256.Substring(0, 6) }
    }
    return [pscustomobject]@{ source = 'none'; value = 'none' }
}

function Get-NewestAssistantMessageText {
    param([object]$Capture)
    $messages = @()
    try { $messages = @($Capture.messages) } catch { $messages = @() }
    for ($index = $messages.Count - 1; $index -ge 0; $index--) {
        $message = $messages[$index]
        $role = $null
        $text = $null
        try { $role = [string]$message.role } catch { $role = $null }
        try { $text = [string]$message.text } catch { $text = $null }
        if ($role -eq 'assistant') { return $text }
    }
    return $null
}

function Test-FinalAssistantLifecycleAnswer {
    param([string]$Text = $null)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
    $trimmed = $Text.Trim()
    return -not [regex]::IsMatch($trimmed, '^(?i:thinking(?:[.\s]|\u2026)*$)')
}

function Invoke-ChatgptLifecycleAnswerCapture {
    param([string]$ChatId = $null, [string]$TargetId = $null, [int]$TimeoutSeconds = 240)
    if ([string]::IsNullOrWhiteSpace($ChatId)) {
        return [pscustomobject]@{ ok = $false; status = 'ANSWER_CAPTURE_FAILED'; chat_id = $null; assistant_message_count = 0; assistant_answer_length = 0; assistant_answer_hash = $null; captured_answer_path = $null; retryable = $true; next_action = 'submit must resolve chat_id before answer capture' }
    }
    Ensure-BuildOutput | Out-Null
    Ensure-Directories
    $node = Get-NodeCommand
    $scriptPath = Join-Path $Root 'dist\cli\chatgpt-browser-session-cli.js'
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastCapture = $null
    $lastAssistantText = $null
    $stableAssistantText = $null
    $stablePollCount = 0
    while ((Get-Date) -lt $deadline) {
        $raw = & $node.Source --enable-source-maps $scriptPath chatgpt-capture -ChatId $ChatId -TimeoutMs 10000 2>&1
        try {
            $lastCapture = ($raw | Out-String | ConvertFrom-Json -ErrorAction Stop)
        } catch {
            return [pscustomobject]@{ ok = $false; status = 'ANSWER_CAPTURE_FAILED'; chat_id = $ChatId; assistant_message_count = 0; assistant_answer_length = 0; assistant_answer_hash = $null; captured_answer_path = $null; retryable = $true; next_action = 'inspect chatgpt-capture output'; error = Sanitize-Text (($raw | Out-String).Trim()) }
        }
        if ($lastCapture.ok -eq $true) {
            $lastAssistantText = Get-NewestAssistantMessageText -Capture $lastCapture
            if (Test-FinalAssistantLifecycleAnswer -Text $lastAssistantText) {
                if ($stableAssistantText -eq $lastAssistantText) { $stablePollCount++ } else { $stableAssistantText = $lastAssistantText; $stablePollCount = 1 }
                if ($stablePollCount -ge 2) {
                    $id6 = Get-ServerLifecycleId6 -ChatId $ChatId -TargetId $TargetId
                    $answerPath = Join-Path $RunDir ('server-lifecycle-answer-{0}.md' -f $id6)
                    Set-Content -LiteralPath $answerPath -Value $lastAssistantText -Encoding utf8
                    $hash = Get-TextSha256 -Text $lastAssistantText
                    return [pscustomobject]@{ ok = $true; status = 'ANSWER_CAPTURED'; chat_id = $ChatId; assistant_message_count = [int]$lastCapture.assistant_message_count; assistant_answer_length = $lastAssistantText.Length; assistant_answer_hash = $hash; captured_answer_path = $answerPath; retryable = $false; next_action = 'prepare Codex handoff' }
                }
            } else {
                $stableAssistantText = $null
                $stablePollCount = 0
            }
        }
        Start-Sleep -Seconds 5
    }
    $assistantCount = 0
    try { $assistantCount = [int]$lastCapture.assistant_message_count } catch { $assistantCount = 0 }
    $answerLength = if ($lastAssistantText) { $lastAssistantText.Length } else { 0 }
    $status = if ($assistantCount -gt 0 -and $answerLength -eq 0) { 'ANSWER_CAPTURE_EMPTY' } else { 'ANSWER_CAPTURE_TIMEOUT' }
    return [pscustomobject]@{ ok = $false; status = $status; chat_id = $ChatId; assistant_message_count = $assistantCount; assistant_answer_length = $answerLength; assistant_answer_hash = $null; captured_answer_path = $null; retryable = $true; next_action = 'retry answer capture after ChatGPT finishes responding' }
}

function New-ServerLifecycleCodexHandoff {
    param([object]$AnswerCapture, [string]$ChatId = $null, [string]$TargetId = $null, [bool]$ExecuteRequested = $false)
    if (-not $AnswerCapture -or $AnswerCapture.ok -ne $true -or [string]::IsNullOrWhiteSpace([string]$AnswerCapture.captured_answer_path)) {
        return [pscustomobject]@{ ok = $false; status = 'CODEX_HANDOFF_SKIPPED'; handoff_prompt_path = $null; branch_name = $null; execute_requested = $ExecuteRequested; executed = $false; next_action = 'capture assistant answer before preparing Codex handoff' }
    }
    $answerPath = [string]$AnswerCapture.captured_answer_path
    if (-not (Test-Path -LiteralPath $answerPath -PathType Leaf)) {
        return [pscustomobject]@{ ok = $false; status = 'CODEX_HANDOFF_FAILED'; handoff_prompt_path = $null; branch_name = $null; execute_requested = $ExecuteRequested; executed = $false; next_action = 'captured answer file missing' }
    }
    $id6 = Get-ServerLifecycleId6 -ChatId $ChatId -TargetId $TargetId
    $branchName = 'fix/lifecycle-diagnostic-remediation-{0}-{1}' -f (Get-Date).ToString('yyyyMMdd-HHmm'), $id6
    $handoffPath = Join-Path $RunDir ('server-lifecycle-codex-handoff-{0}.md' -f $id6)
    $answerText = Get-Content -LiteralPath $answerPath -Raw
    $mixin = @(
        ('You are Codex CLI working on {0}.' -f $Root),
        ('Create or use a separate branch named {0}.' -f $branchName),
        'Do not work directly on master.',
        'Do not restart the server stack unless explicitly required.',
        'Read the diagnostic assistant answer below unchanged.',
        'Implement only issues that are explicitly marked as not ready, risky, fragile, broken, missing, or incomplete.',
        'Execute fixes from cheapest/safest to most expensive/risky.',
        'Prefer small isolated patches.',
        'Run build/typecheck/smoke gates.',
        'Do not merge to master.',
        'Return changed files, commits, gates, and remaining risks.'
    ) -join [Environment]::NewLine
    $handoff = $mixin + [Environment]::NewLine + [Environment]::NewLine + 'Diagnostic assistant answer:' + [Environment]::NewLine + [Environment]::NewLine + $answerText
    Set-Content -LiteralPath $handoffPath -Value $handoff -Encoding utf8
    if (-not $ExecuteRequested) {
        return [pscustomobject]@{ ok = $true; status = 'CODEX_HANDOFF_PREPARED'; handoff_prompt_path = $handoffPath; branch_name = $branchName; execute_requested = $false; executed = $false; next_action = 'run with -ExecuteCodexHandoff to execute Codex CLI handoff' }
    }
    return [pscustomobject]@{ ok = $false; status = 'CODEX_HANDOFF_FAILED'; handoff_prompt_path = $handoffPath; branch_name = $branchName; execute_requested = $true; executed = $false; next_action = 'Codex CLI execution is intentionally not wired in this lifecycle wrapper yet; run the prepared prompt manually with full task permissions' }
}

function Get-ServerLifecycleSuggestedChatTitleMetadata {
    param([string]$ChatId = $null, [string]$TargetId = $null, [string]$PromptFile = $ServerLifecyclePromptFile)
    $full = Get-ServerLifecycleSuggestedChatTitleFull
    $datePart = $null
    $timePart = $null
    $match = [regex]::Match($full, '(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})')
    if ($match.Success) {
        $datePart = $match.Groups[2].Value + $match.Groups[3].Value
        $timePart = $match.Groups[4].Value + $match.Groups[5].Value
    }
    if ([string]::IsNullOrWhiteSpace($datePart)) { $datePart = (Get-Date).ToString('MMdd') }
    if ([string]::IsNullOrWhiteSpace($timePart)) { $timePart = (Get-Date).ToString('HHmm') }
    $id = Get-ServerLifecycleTitleIdSource -ChatId $ChatId -TargetId $TargetId -PromptFile $PromptFile
    $compact = 'MCP {0} {1} {2}' -f $datePart, $timePart, $id.value
    return [pscustomobject]@{
        suggested_chat_title_full = $full
        suggested_chat_title_compact = $compact
        title_id_source = $id.source
    }
}

function New-ServerLifecycleLaunchPrompt {
    param([string]$Operation = 'manual', [string]$Generation = $null, [string]$Mode = $null, [string]$Status = $null, [object]$Detail = $null)
    Ensure-Directories
    $git = Get-CompactGitLifecycleSummary
    try { $warmth = Invoke-ChatgptSessionWarmth } catch { $warmth = [pscustomobject]@{ ok = $false; status = 'CHATGPT_SESSION_WARMTH_UNAVAILABLE'; error = Sanitize-Text $_.Exception.Message } }
    $tail = Get-ServerLifecycleLogTail -MaxLines 80
    $suggestedTitle = 'Console MCP Lifecycle Review ' + (Get-Date).ToString('yyyy-MM-dd HH:mm')
    $issueCount = 0
    if ($warmth -and $warmth.ok -ne $true) { $issueCount++ }
    if ($git.dirty_count -gt 0) { $issueCount++ }
    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($line in @(
        'Console MCP server lifecycle completed.', '', 'Lifecycle summary:',
        ('- operation: {0}' -f $Operation), ('- generation: {0}' -f $(if ($Generation) { $Generation } else { 'n/a' })),
        ('- mode: {0}' -f $(if ($Mode) { $Mode } else { 'n/a' })), ('- status: {0}' -f $(if ($Status) { $Status } else { 'n/a' })),
        ('- git head: {0}' -f $(if ($git.head) { $git.head } else { 'unknown' })), ('- git dirty count: {0}' -f $git.dirty_count),
        ('- ChatGPT session warmth: {0}' -f $(if ($warmth.status) { $warmth.status } else { 'unknown' })), ('- suggested chat title: {0}' -f $suggestedTitle),
        '', 'Compact lifecycle log tail:'
    )) { $lines.Add($line) | Out-Null }
    if ($tail.Count -gt 0) { foreach ($line in $tail) { $lines.Add($line) | Out-Null } } else { $lines.Add('(empty)') | Out-Null }
    $lines.Add('') | Out-Null
    $lines.Add('Git status:') | Out-Null
    if ($git.status.Count -gt 0) { foreach ($line in $git.status) { $lines.Add(('- {0}' -f $line)) | Out-Null } } else { $lines.Add('- clean') | Out-Null }
    foreach ($line in @(
        '', 'Task:',
        'Go to the console-mcp repository and perform a deep technical review of the current lifecycle/startup/watchdog/browser automation implementation.',
        '', 'Focus:', '1. bugs and fragility', '2. SOLID violations', '3. lifecycle anti-patterns', '4. noisy logs and over-nested JSON',
        '5. unsafe restart/relaunch behavior', '6. duplicated responsibilities between dev-console.ps1, browser-session executor, watchdog, and MCP tools',
        '7. exact files/functions that should be changed next', '', 'Return:', '- concise findings', '- risk level', '- exact files/functions', '- safe next patch proposal'
    )) { $lines.Add($line) | Out-Null }
    $prompt = ($lines -join [Environment]::NewLine)
    Set-Content -LiteralPath $ServerLifecyclePromptFile -Value $prompt -Encoding utf8
    $titleMetadata = Get-ServerLifecycleSuggestedChatTitleMetadata -PromptFile $ServerLifecyclePromptFile
    return [pscustomobject]@{ ok = $true; status = 'SERVER_LIFECYCLE_PROMPT_READY'; prompt_file = $ServerLifecyclePromptFile; prompt_length = $prompt.Length; lifecycle_log_file = $ServerLifecycleLogFile; issue_count = $issueCount; suggested_chat_title = $titleMetadata.suggested_chat_title_compact; suggested_chat_title_full = $titleMetadata.suggested_chat_title_full; suggested_chat_title_compact = $titleMetadata.suggested_chat_title_compact; title_id_source = $titleMetadata.title_id_source; next_action = 'chatgpt-send-lifecycle-review-prompt' }
}

function Invoke-ServerLifecyclePromptCommand {
    $result = New-ServerLifecycleLaunchPrompt -Operation 'manual' -Status 'MANUAL_PROMPT_REQUEST'
    return ($result | ConvertTo-Json -Depth 8)
}

function Invoke-ChatgptOpenRootTarget {
    param([int]$Port = 9223)
    $uri = "http://127.0.0.1:$Port/json/new?https://chatgpt.com/"
    try {
        $response = Invoke-WebRequest -Uri $uri -Method Put -TimeoutSec 5 -SkipHttpErrorCheck -ErrorAction Stop
        return [pscustomobject]@{ ok = [bool]($response.StatusCode -ge 200 -and $response.StatusCode -lt 300); status = 'CHATGPT_ROOT_TARGET_OPEN_REQUESTED'; port = $Port; http_status = [int]$response.StatusCode }
    } catch {
        return [pscustomobject]@{ ok = $false; status = 'CHATGPT_ROOT_TARGET_OPEN_FAILED'; port = $Port; error = Sanitize-Text $_.Exception.Message }
    }
}

function Wait-ChatgptLifecycleReviewRootReady {
    param([int]$TimeoutSeconds = 20)
    $node = Get-NodeCommand
    $scriptPath = Join-Path $Root 'dist\cli\chatgpt-browser-session-cli.js'
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $last = $null
    while ((Get-Date) -lt $deadline) {
        $raw = & $node.Source --enable-source-maps $scriptPath chatgpt-preflight 2>&1
        try { $last = ($raw | Out-String | ConvertFrom-Json) } catch { $last = [pscustomobject]@{ ok = $false; status = 'CHATGPT_PREFLIGHT_OUTPUT_UNPARSEABLE'; raw = Sanitize-Text (($raw | Out-String).Trim()) } }
        if ($last.ok -eq $true -and $last.status -eq 'COMPOSER_PREFLIGHT_READY') {
            return [pscustomobject]@{ ok = $true; status = 'CHATGPT_LIFECYCLE_REVIEW_ROOT_READY'; preflight = $last }
        }
        Start-Sleep -Milliseconds 500
    }
    return [pscustomobject]@{ ok = $false; status = 'CHATGPT_LIFECYCLE_REVIEW_ROOT_NOT_READY'; preflight = $last }
}

function Invoke-ChatgptOpenNewChat {
    param([string[]]$Arguments = @())
    $confirmOpen = @($Arguments) -contains '-ConfirmOpen' -or @($Arguments) -contains '--confirm-open'
    $transportIndex = [Array]::IndexOf($Arguments, '-PromptTransport')
    if ($transportIndex -lt 0) { $transportIndex = [Array]::IndexOf($Arguments, '--prompt-transport') }
    $promptTransport = if ($transportIndex -ge 0 -and $Arguments.Count -gt ($transportIndex + 1)) { [string]$Arguments[$transportIndex + 1] } else { 'INLINE_TEXT' }
    if ($promptTransport -notin @('INLINE_TEXT', 'FILE_ATTACHMENT')) { $promptTransport = 'INLINE_TEXT' }
    $warmthBefore = Invoke-ChatgptSessionWarmth
    $readyBefore = Wait-ChatgptLifecycleReviewRootReady -TimeoutSeconds 5
    if ($readyBefore.ok -eq $true) {
        return ([pscustomobject]@{ ok = $true; status = 'CHATGPT_NEW_CHAT_READY'; warmth_before = $warmthBefore; open_root_target = $null; root_ready = $readyBefore; next_action = 'chatgpt-submit-ready-chat' } | ConvertTo-Json -Depth 30)
    }
    if (-not $confirmOpen) {
        return ([pscustomobject]@{ ok = $false; status = 'CHATGPT_NEW_CHAT_OPEN_CONFIRM_REQUIRED'; warmth_before = $warmthBefore; root_ready = $readyBefore; next_action = 'rerun with -ConfirmOpen' } | ConvertTo-Json -Depth 30)
    }

    if ($warmthBefore.root_target_count -gt 1) {
        $keepTargetId = $null
        try { $keepTargetId = [string]$warmthBefore.inventory_summary.selected_target_candidates[0].id } catch { $keepTargetId = $null }
        if ([string]::IsNullOrWhiteSpace($keepTargetId)) {
            return ([pscustomobject]@{ ok = $false; status = 'CHATGPT_NEW_CHAT_ROOT_PRUNE_KEEP_TARGET_UNRESOLVED'; warmth_before = $warmthBefore; next_action = 'inspect root target candidates' } | ConvertTo-Json -Depth 30)
        }
        Invoke-ChatgptBrowserSessionCli -CliCommand 'chatgpt-prune-root-targets' -Arguments @('-KeepTargetId', $keepTargetId, '-ConfirmCleanup') | Out-Null
        $warmthBefore = Invoke-ChatgptSessionWarmth
    }

    $discardedDirtyRoot = $null
    if ($warmthBefore.root_target_count -gt 0) {
        $rootReady = Wait-ChatgptLifecycleReviewRootReady -TimeoutSeconds 20
        if ($rootReady.ok -eq $true) {
            return ([pscustomobject]@{ ok = $true; status = 'CHATGPT_NEW_CHAT_READY'; warmth_before = $warmthBefore; open_root_target = $null; root_ready = $rootReady; next_action = 'chatgpt-submit-ready-chat' } | ConvertTo-Json -Depth 30)
        }

        $dirtyRootTargetId = $null
        $dirtyRootTextLength = $null
        $dirtyRootMessageCount = $null
        try {
            $rejection = $rootReady.preflight.candidate_rejections[0]
            if ($rejection.rejection_reason -eq 'COMPOSER_NOT_EMPTY' -and [int]$rejection.message_count -eq 0) {
                $dirtyRootTargetId = [string]$rejection.target_id
                $dirtyRootTextLength = [int]$rejection.composer_text_length
                $dirtyRootMessageCount = [int]$rejection.message_count
            }
        } catch { $dirtyRootTargetId = $null }

        if ([string]::IsNullOrWhiteSpace($dirtyRootTargetId)) {
            return ([pscustomobject]@{ ok = $false; status = 'CHATGPT_NEW_CHAT_ROOT_NOT_READY'; warmth_before = $warmthBefore; open_root_target = $null; root_ready = $rootReady; next_action = 'inspect existing root target readiness' } | ConvertTo-Json -Depth 30)
        }

        if ($promptTransport -eq 'FILE_ATTACHMENT') {
            return ([pscustomobject]@{ ok = $true; status = 'CHATGPT_NEW_CHAT_DIRTY_ROOT_ACCEPTED_FOR_ATTACHMENT_TRANSPORT'; warmth_before = $warmthBefore; open_root_target = $null; root_ready = $rootReady; dirty_root = [pscustomobject]@{ target_id = $dirtyRootTargetId; composer_text_length = $dirtyRootTextLength; message_count = $dirtyRootMessageCount }; next_action = 'chatgpt-submit-ready-chat with FILE_ATTACHMENT and AllowOverwrite' } | ConvertTo-Json -Depth 30)
        }

        try {
            $closeUri = "http://127.0.0.1:9223/json/close/$dirtyRootTargetId"
            $closeResponse = Invoke-WebRequest -Uri $closeUri -Method Get -TimeoutSec 5 -SkipHttpErrorCheck -ErrorAction Stop
            $discardedDirtyRoot = [pscustomobject]@{ ok = [bool]($closeResponse.StatusCode -ge 200 -and $closeResponse.StatusCode -lt 300); status = 'CHATGPT_DIRTY_ROOT_TARGET_CLOSED'; target_id = $dirtyRootTargetId; composer_text_length = $dirtyRootTextLength; message_count = $dirtyRootMessageCount; http_status = [int]$closeResponse.StatusCode }
        } catch {
            return ([pscustomobject]@{ ok = $false; status = 'CHATGPT_DIRTY_ROOT_TARGET_CLOSE_FAILED'; warmth_before = $warmthBefore; root_ready = $rootReady; target_id = $dirtyRootTargetId; error = Sanitize-Text $_.Exception.Message; next_action = 'manual close dirty root target' } | ConvertTo-Json -Depth 30)
        }
        Start-Sleep -Milliseconds 500
        $warmthBefore = Invoke-ChatgptSessionWarmth
    }

    $openRoot = Invoke-ChatgptOpenRootTarget -Port 9223
    if ($openRoot.ok -ne $true) {
        return ([pscustomobject]@{ ok = $false; status = 'CHATGPT_NEW_CHAT_OPEN_FAILED'; warmth_before = $warmthBefore; discarded_dirty_root = $discardedDirtyRoot; open_root_target = $openRoot; next_action = 'inspect CDP target creation' } | ConvertTo-Json -Depth 30)
    }
    $rootReady = Wait-ChatgptLifecycleReviewRootReady -TimeoutSeconds 20
    $ok = [bool]($rootReady.ok -eq $true)
    if (-not $ok -and $promptTransport -eq 'FILE_ATTACHMENT') {
        try {
            $rejection = $rootReady.preflight.candidate_rejections[0]
            if ($rejection.rejection_reason -eq 'COMPOSER_NOT_EMPTY' -and [int]$rejection.message_count -eq 0) {
                return ([pscustomobject]@{ ok = $true; status = 'CHATGPT_NEW_CHAT_OPENED_DIRTY_ROOT_ACCEPTED_FOR_ATTACHMENT_TRANSPORT'; warmth_before = $warmthBefore; discarded_dirty_root = $discardedDirtyRoot; open_root_target = $openRoot; root_ready = $rootReady; dirty_root = [pscustomobject]@{ target_id = [string]$rejection.target_id; composer_text_length = [int]$rejection.composer_text_length; message_count = [int]$rejection.message_count }; next_action = 'chatgpt-submit-ready-chat with FILE_ATTACHMENT and AllowOverwrite' } | ConvertTo-Json -Depth 30)
            }
        } catch { }
    }
    return ([pscustomobject]@{ ok = $ok; status = if ($ok) { 'CHATGPT_NEW_CHAT_OPENED_READY' } else { 'CHATGPT_NEW_CHAT_ROOT_NOT_READY' }; warmth_before = $warmthBefore; discarded_dirty_root = $discardedDirtyRoot; open_root_target = $openRoot; root_ready = $rootReady; next_action = if ($ok) { 'chatgpt-submit-ready-chat' } else { 'inspect root_ready diagnostics' } } | ConvertTo-Json -Depth 30)
}

function Invoke-ChatgptSubmitReadyChat {
    param([string[]]$Arguments = @())
    $confirmSubmit = @($Arguments) -contains '-ConfirmSend' -or @($Arguments) -contains '--confirm-send'
    $promptIndex = [Array]::IndexOf($Arguments, '-PromptFile')
    if ($promptIndex -lt 0) { $promptIndex = [Array]::IndexOf($Arguments, '--prompt-file') }
    $promptFile = if ($promptIndex -ge 0 -and $Arguments.Count -gt ($promptIndex + 1)) { [string]$Arguments[$promptIndex + 1] } else { $null }
    $transportIndex = [Array]::IndexOf($Arguments, '-PromptTransport')
    if ($transportIndex -lt 0) { $transportIndex = [Array]::IndexOf($Arguments, '--prompt-transport') }
    $promptTransport = if ($transportIndex -ge 0 -and $Arguments.Count -gt ($transportIndex + 1)) { [string]$Arguments[$transportIndex + 1] } else { 'INLINE_TEXT' }
    if ($promptTransport -notin @('INLINE_TEXT', 'FILE_ATTACHMENT')) { $promptTransport = 'INLINE_TEXT' }
    if (-not $confirmSubmit) { return ([pscustomobject]@{ ok = $false; status = 'CHATGPT_READY_CHAT_SUBMIT_CONFIRM_REQUIRED'; prompt_file = $promptFile; prompt_transport = $promptTransport; next_action = 'rerun with -ConfirmSend' } | ConvertTo-Json -Depth 8) }
    if ([string]::IsNullOrWhiteSpace($promptFile) -or -not (Test-Path -LiteralPath $promptFile -PathType Leaf)) { return ([pscustomobject]@{ ok = $false; status = 'CHATGPT_READY_CHAT_PROMPT_FILE_MISSING'; prompt_file = $promptFile; prompt_transport = $promptTransport; next_action = 'provide -PromptFile' } | ConvertTo-Json -Depth 8) }
    $preflight = Wait-ChatgptLifecycleReviewRootReady -TimeoutSeconds 5
    $submitExistingTargetId = $null
    if ($preflight.ok -ne $true) {
        try {
            $rejection = $preflight.preflight.candidate_rejections[0]
            if ($promptTransport -eq 'INLINE_TEXT' -and $rejection.rejection_reason -eq 'COMPOSER_NOT_EMPTY' -and $rejection.send_control_enabled -eq $true) { $submitExistingTargetId = [string]$rejection.target_id }
            if ($promptTransport -eq 'FILE_ATTACHMENT' -and $rejection.rejection_reason -eq 'COMPOSER_NOT_EMPTY' -and [int]$rejection.message_count -eq 0) { $submitExistingTargetId = $null }
        } catch { $submitExistingTargetId = $null }
        if ([string]::IsNullOrWhiteSpace($submitExistingTargetId)) {
            $attachmentDirtyRootAccepted = $false
            try {
                $rejection = $preflight.preflight.candidate_rejections[0]
                $attachmentDirtyRootAccepted = [bool]($promptTransport -eq 'FILE_ATTACHMENT' -and $rejection.rejection_reason -eq 'COMPOSER_NOT_EMPTY' -and [int]$rejection.message_count -eq 0)
            } catch { $attachmentDirtyRootAccepted = $false }
            if (-not $attachmentDirtyRootAccepted) { return ([pscustomobject]@{ ok = $false; status = 'CHATGPT_READY_CHAT_NOT_READY'; prompt_file = $promptFile; prompt_transport = $promptTransport; preflight = $preflight; next_action = 'run chatgpt-open-new-chat -ConfirmOpen' } | ConvertTo-Json -Depth 30) }
        }
    }
    Ensure-BuildOutput | Out-Null
    $node = Get-NodeCommand
    $scriptPath = Join-Path $Root 'dist\cli\chatgpt-browser-session-cli.js'
    if ([string]::IsNullOrWhiteSpace($submitExistingTargetId)) {
        $sendArgs = @('chatgpt-send', '-PromptFile', $promptFile, '-PromptTransport', $promptTransport, '-ConfirmSend')
        if ($promptTransport -eq 'FILE_ATTACHMENT') { $sendArgs += '-AllowOverwrite' }
        $raw = & $node.Source --enable-source-maps $scriptPath @sendArgs 2>&1
    } else {
        $raw = & $node.Source --enable-source-maps $scriptPath chatgpt-submit -TargetId $submitExistingTargetId -ConfirmSubmit 2>&1
    }
    $exitCode = $LASTEXITCODE
    try { $parsed = ($raw | Out-String | ConvertFrom-Json) } catch { $parsed = [pscustomobject]@{ ok = $false; status = 'CHATGPT_READY_CHAT_SUBMIT_OUTPUT_UNPARSEABLE'; raw = Sanitize-Text (($raw | Out-String).Trim()) } }
    $ok = [bool]($exitCode -eq 0 -and $parsed.ok -eq $true)
    return ([pscustomobject]@{ ok = $ok; status = if ($ok) { 'CHATGPT_READY_CHAT_SUBMIT_DONE' } else { 'CHATGPT_READY_CHAT_SUBMIT_FAILED' }; prompt_file = $promptFile; prompt_transport = $promptTransport; target_id = $parsed.target_id; chat_id = $parsed.chat_id; submitted = $parsed.submitted; preflight = $preflight; submit = $parsed; next_action = if ($ok) { 'rename lifecycle review chat' } else { 'inspect submit result' } } | ConvertTo-Json -Depth 30)
}

function Get-ServerLifecycleSuggestedChatTitle { return (Get-ServerLifecycleSuggestedChatTitleMetadata).suggested_chat_title_compact }
function Invoke-ChatgptRenameLifecycleReviewChat { param([string[]]$Arguments=@(), [string]$ChatId=$null, [string]$TargetId=$null, [string]$PromptFile=$ServerLifecyclePromptFile); $confirmRename=@($Arguments)-contains '-ConfirmRename' -or @($Arguments)-contains '--confirm-rename'; $titleMetadata=Get-ServerLifecycleSuggestedChatTitleMetadata -ChatId $ChatId -TargetId $TargetId -PromptFile $PromptFile; $title=$titleMetadata.suggested_chat_title_compact; if(-not $confirmRename){return ([pscustomobject]@{ok=$false;status='CHATGPT_LIFECYCLE_RENAME_CONFIRM_REQUIRED';suggested_chat_title=$title;suggested_chat_title_full=$titleMetadata.suggested_chat_title_full;suggested_chat_title_compact=$titleMetadata.suggested_chat_title_compact;title_id_source=$titleMetadata.title_id_source;next_action='rerun with -ConfirmRename'}|ConvertTo-Json -Depth 30)}; Ensure-BuildOutput|Out-Null; $node=Get-Command node -ErrorAction Stop; $scriptPath=Join-Path $Root 'dist\cli\chatgpt-browser-session-cli.js'; $raw=& $node.Source --enable-source-maps $scriptPath chatgpt-rename-latest -Title $title 2>&1; $text=($raw|Out-String).Trim(); try{$rename=$text|ConvertFrom-Json -ErrorAction Stop}catch{$rename=[pscustomobject]@{ok=$false;status='CHATGPT_LIFECYCLE_RENAME_PARSE_FAILED';raw=$text}}; return ([pscustomobject]@{ok=[bool]($rename.ok -eq $true);status=if($rename.ok -eq $true){'CHATGPT_LIFECYCLE_RENAME_DONE'}else{'CHATGPT_LIFECYCLE_RENAME_FAILED'};suggested_chat_title=$title;suggested_chat_title_full=$titleMetadata.suggested_chat_title_full;suggested_chat_title_compact=$titleMetadata.suggested_chat_title_compact;title_id_source=$titleMetadata.title_id_source;rename=$rename}|ConvertTo-Json -Depth 40) }
function Invoke-ChatgptSendLifecycleReviewPrompt {
    param([string[]]$Arguments = @())
    $confirmSend = @($Arguments) -contains '-ConfirmSend' -or @($Arguments) -contains '--confirm-send'
    $prepareCodexHandoff = $true
    if (@($Arguments) -contains '-PrepareCodexHandoff' -or @($Arguments) -contains '--prepare-codex-handoff') { $prepareCodexHandoff = $true }
    $executeCodexHandoff = @($Arguments) -contains '-ExecuteCodexHandoff' -or @($Arguments) -contains '--execute-codex-handoff'
    $promptTransport = 'FILE_ATTACHMENT'
    if (-not $confirmSend) {
        $plan = New-ServerLifecycleLaunchPrompt -Operation 'manual' -Status 'SEND_REQUIRES_CONFIRMATION'
        return ([pscustomobject]@{ ok = $false; status = 'CHATGPT_LIFECYCLE_REVIEW_SEND_CONFIRM_REQUIRED'; prompt_file = $plan.prompt_file; prompt_length = $plan.prompt_length; prompt_transport = $promptTransport; suggested_chat_title = $plan.suggested_chat_title; suggested_chat_title_full = $plan.suggested_chat_title_full; suggested_chat_title_compact = $plan.suggested_chat_title_compact; title_id_source = $plan.title_id_source; next_action = 'rerun with -ConfirmSend' } | ConvertTo-Json -Depth 8)
    }
    $plan = New-ServerLifecycleLaunchPrompt -Operation 'manual' -Status 'SEND_CONFIRMED'
    $openParsed = (Invoke-ChatgptOpenNewChat -Arguments @('-ConfirmOpen', '-PromptTransport', $promptTransport)) | ConvertFrom-Json
    if ($openParsed.ok -ne $true) {
        $state = [pscustomobject]@{ ok = $false; status = 'CHATGPT_LIFECYCLE_REVIEW_OPEN_FAILED'; at = (Get-Date).ToString('o'); prompt_file = $plan.prompt_file; prompt_length = $plan.prompt_length; prompt_transport = $promptTransport; suggested_chat_title = $plan.suggested_chat_title; suggested_chat_title_full = $plan.suggested_chat_title_full; suggested_chat_title_compact = $plan.suggested_chat_title_compact; title_id_source = $plan.title_id_source; open = $openParsed; state_file = $ServerLifecycleSendStateFile; next_action = 'inspect open result' }
        $json = ConvertTo-SafeBrowserAutomationJson -Value $state -Depth 30
        $json | Set-Content -LiteralPath $ServerLifecycleSendStateFile -Encoding utf8
        return $json
    }
    $submitParsed = (Invoke-ChatgptSubmitReadyChat -Arguments @('-PromptFile', $plan.prompt_file, '-PromptTransport', $promptTransport, '-ConfirmSend')) | ConvertFrom-Json
    $renameParsed = $null
    if ($submitParsed.ok -eq $true) { $renameParsed = (Invoke-ChatgptRenameLifecycleReviewChat -Arguments @('-ConfirmRename') -ChatId $submitParsed.chat_id -TargetId $submitParsed.target_id -PromptFile $plan.prompt_file) | ConvertFrom-Json }
    $answerCapture = $null
    if ($submitParsed.ok -eq $true) {
        $answerCapture = Invoke-ChatgptLifecycleAnswerCapture -ChatId $submitParsed.chat_id -TargetId $submitParsed.target_id
    } else {
        $answerCapture = [pscustomobject]@{ ok = $false; status = 'ANSWER_CAPTURE_FAILED'; chat_id = $submitParsed.chat_id; assistant_message_count = 0; assistant_answer_length = 0; assistant_answer_hash = $null; captured_answer_path = $null; retryable = $true; next_action = 'submit must complete before answer capture' }
    }
    if ($submitParsed.ok -eq $true -and $answerCapture.ok -eq $true -and (-not $renameParsed -or $renameParsed.ok -ne $true)) {
        $renameParsed = (Invoke-ChatgptRenameLifecycleReviewChat -Arguments @('-ConfirmRename') -ChatId $submitParsed.chat_id -TargetId $submitParsed.target_id -PromptFile $plan.prompt_file) | ConvertFrom-Json
    }
    $codexHandoff = if ($prepareCodexHandoff -or $executeCodexHandoff) {
        New-ServerLifecycleCodexHandoff -AnswerCapture $answerCapture -ChatId $submitParsed.chat_id -TargetId $submitParsed.target_id -ExecuteRequested $executeCodexHandoff
    } else {
        [pscustomobject]@{ ok = $true; status = 'CODEX_HANDOFF_SKIPPED'; handoff_prompt_path = $null; branch_name = $null; execute_requested = $false; executed = $false; next_action = 'rerun with -PrepareCodexHandoff to prepare Codex handoff' }
    }
    $titleMetadata = if ($renameParsed) { $renameParsed } else { Get-ServerLifecycleSuggestedChatTitleMetadata -ChatId $submitParsed.chat_id -TargetId $submitParsed.target_id -PromptFile $plan.prompt_file }
    $ok = [bool]($submitParsed.ok -eq $true -and ($null -eq $renameParsed -or $renameParsed.ok -eq $true) -and $answerCapture.ok -eq $true -and $codexHandoff.ok -eq $true)
    $status = if ($ok) { 'CHATGPT_LIFECYCLE_REVIEW_SEND_RENAME_CAPTURE_HANDOFF_DONE' } elseif ($submitParsed.ok -ne $true) { 'CHATGPT_LIFECYCLE_REVIEW_SEND_FAILED' } elseif (-not $renameParsed -or $renameParsed.ok -ne $true) { 'CHATGPT_LIFECYCLE_REVIEW_RENAME_FAILED' } elseif ($answerCapture.ok -ne $true) { 'CHATGPT_LIFECYCLE_REVIEW_ANSWER_CAPTURE_FAILED' } else { 'CHATGPT_LIFECYCLE_REVIEW_CODEX_HANDOFF_FAILED' }
    $state = [pscustomobject]@{ ok = $ok; status = $status; at = (Get-Date).ToString('o'); prompt_file = $plan.prompt_file; prompt_length = $plan.prompt_length; prompt_transport = $promptTransport; suggested_chat_title = $titleMetadata.suggested_chat_title_compact; suggested_chat_title_full = $titleMetadata.suggested_chat_title_full; suggested_chat_title_compact = $titleMetadata.suggested_chat_title_compact; title_id_source = $titleMetadata.title_id_source; open = $openParsed; submit = $submitParsed; rename = $renameParsed; answer_capture = $answerCapture; codex_handoff = $codexHandoff; state_file = $ServerLifecycleSendStateFile; next_action = if ($ok) { 'done' } elseif ($submitParsed.ok -ne $true) { 'inspect submit result' } elseif (-not $renameParsed -or $renameParsed.ok -ne $true) { 'inspect rename result' } elseif ($answerCapture.ok -ne $true) { 'inspect answer_capture result' } elseif ($codexHandoff.ok -ne $true) { 'inspect codex_handoff result' } else { 'inspect lifecycle result' } }
    $json = ConvertTo-SafeBrowserAutomationJson -Value $state -Depth 30
    $json | Set-Content -LiteralPath $ServerLifecycleSendStateFile -Encoding utf8
    return $json
}

