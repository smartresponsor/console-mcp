$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$npm = Get-Command npm -ErrorAction Stop
$node = Get-Command node -ErrorAction Stop

if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules'))) {
    & $npm.Source install
}

& $npm.Source run build
& $node.Source (Join-Path $root 'tool/validate-console-tool-catalog.mjs')
if ($LASTEXITCODE -ne 0) {
    throw "console tool catalog validator failed."
}

& $node.Source (Join-Path $root 'tool/chatgpt-adopt-schema-regression.mjs')
if ($LASTEXITCODE -ne 0) {
    throw "ChatGPT adopt registered schema regression failed."
}

& (Get-Command pwsh -ErrorAction Stop).Source -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'tool/console-server-lifecycle-regression.ps1')
if ($LASTEXITCODE -ne 0) {
    throw "Console server lifecycle regression failed."
}

& $node.Source (Join-Path $root 'tool/chatgpt-task-binding-regression.mjs')
if ($LASTEXITCODE -ne 0) {
    throw "ChatGPT exact task binding regression failed."
}

$devConsoleSource = Get-Content -LiteralPath (Join-Path $root 'tool/dev-console.ps1') -Raw
$packageSource = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw
foreach ($forbiddenWatchdogHandle in @("'stop-watchdog-loop'", "'uninstall-watchdog-task'", '"dev:watchdog-loop-stop"', '"dev:watchdog-uninstall"')) {
    if ($devConsoleSource.Contains($forbiddenWatchdogHandle) -or $packageSource.Contains($forbiddenWatchdogHandle)) {
        throw "Watchdog ownership regression failed: public stop/disable handle remains: $forbiddenWatchdogHandle"
    }
}
if (-not $devConsoleSource.Contains("'restart-watchdog-loop' { Restart-WatchdogLoop }")) {
    throw "Watchdog ownership regression failed: restart handle is missing."
}
if (-not $devConsoleSource.Contains('Stop-WatchdogLoop | Out-Null')) {
    throw "Watchdog ownership regression failed: restart no longer owns its internal stop/start sequence."
}

$entrypointPresetSource = Get-Content -LiteralPath (Join-Path $root 'src/service/chatgpt-entrypoint-preset.ts') -Raw
$entrypointTemplateSource = Get-Content -LiteralPath (Join-Path $root 'prompt/chatgpt/repo-rc-implementation.md') -Raw
$entrypointRequiredTokens = @(
    'Required opening mixin:',
    'REPO_RC_PROMPT_TEMPLATE_RELATIVE_PATH = "prompt/chatgpt/repo-rc-implementation.md"',
    'loadRepoRcPromptTemplate()',
    '{{rawPrompt}}',
    '{{workspacePath}}',
    '{{componentName}}',
    'Related stack reconnaissance:',
    'Objecting',
    'Cruding',
    'Canonisating',
    'Viewing',
    'Interfacing',
    'Navigating',
    'market, competitors, mature open-source projects, SaaS products, and enterprise practices',
    'single responsibility boundary',
    'baseline market expectations',
    'advanced maturity capabilities',
    'fragility, technical debt, safeguards',
    'outside this component boundary',
    'RC-critical milestone track',
    'technical debt, hardening, fixes',
    'boundary enforcement, tests, gates, observability, diagnostics',
    'separate growth milestone track',
    'maturity uplift, UX/DX/API improvements',
    'competitive parity or advantage',
    'post-RC roadmap items',
    'do not violate the boundary',
    'do not block RC on speculative growth',
    'Что имеем? Что осталось?'
)
foreach ($entrypointRequiredToken in $entrypointRequiredTokens) {
    if (-not ($entrypointPresetSource.Contains($entrypointRequiredToken) -or $entrypointTemplateSource.Contains($entrypointRequiredToken))) {
        throw "ChatGPT entrypoint preset regression failed: missing token '$entrypointRequiredToken'."
    }
}

$entrypointChatOpenSource = Get-Content -LiteralPath (Join-Path $root 'src/tool/chatgpt-chat-open.ts') -Raw
$entrypointChatOpenRequiredTokens = @(
    'confirmStart: z.boolean().default(true)',
    'requires_confirm_start: false',
    'default_confirm_start: true',
    'const beforeHead = await captureWorkspaceHead(policy, input.workspacePath);',
    'beforeHead: beforeHead ?? undefined,',
    'before_head: beforeHead,',
    'async function captureWorkspaceHead(policy: ConsolePolicy, workspacePath: string): Promise<string | null>',
    'runSupervisedCommand(cwd, "git", ["rev-parse", "HEAD"], 30000, 1024 * 1024)',
    'return /^[A-Fa-f0-9]+$/.test(head) ? head : null;',
    'requireEmptyHomeComposer: !input.allowOverwrite',
    'REUSABLE_HOME_TARGET_COMPOSER_NOT_EMPTY',
    'findFirstEmptyComposerHomeTarget(candidates, timeoutMs, options)',
    'skipped_reusable_targets: skippedReusableTargets'
)
foreach ($entrypointChatOpenRequiredToken in $entrypointChatOpenRequiredTokens) {
    if (-not $entrypointChatOpenSource.Contains($entrypointChatOpenRequiredToken)) {
        throw "ChatGPT entrypoint start regression failed: missing token '$entrypointChatOpenRequiredToken'."
    }
}

$chatGptRunLoopDocSource = Get-Content -LiteralPath (Join-Path $root 'docs/chatgpt-run-loop-orchestration.md') -Raw
$chatGptRunLoopDocRequiredTokens = @(
    'summary.soft_recovery_actions',
    'console.write.browser.session.control.activate',
    'console.read_.browser.chatgpt.tab.inventory',
    'console.write.browser.session.target.cleanup',
    'confirmAction=true',
    'confirmCleanup=true',
    'must not submit prompts'
)
foreach ($chatGptRunLoopDocRequiredToken in $chatGptRunLoopDocRequiredTokens) {
    if (-not $chatGptRunLoopDocSource.Contains($chatGptRunLoopDocRequiredToken)) {
        throw "ChatGPT run-loop documentation regression failed: missing token '$chatGptRunLoopDocRequiredToken'."
    }
}

$chatGptMessageCaptureSource = Get-Content -LiteralPath (Join-Path $root 'src/tool/chatgpt-message-capture.ts') -Raw
$chatGptMessageCaptureRequiredTokens = @(
    'type LatestAssistantControls =',
    'latest_assistant_controls: state.latestAssistantControls,',
    'const latestAssistantControls = { copy_visible:',
    'JSON.stringify(latestAssistantControls)',
    'latestAssistantControls, outline:',
    'function normalizeLatestAssistantControls(raw: unknown): LatestAssistantControls',
    'soft_recovery_actions: buildSoftRecoveryActions("CLIENT_STREAM_ERROR")',
    'function buildSoftRecoveryActions(status: string): string[]',
    'CLICK_LATEST_RETHINK',
    'CAPTURE_CURRENT_ASSISTANT',
    'console.write.browser.session.control.activate',
    'CONFIRM_MESSAGE_CONTROL_CLICK_REQUIRED',
    'buildLatestAssistantControlClickExpression',
    'requires_explicit_confirmation: true'
)
foreach ($chatGptMessageCaptureRequiredToken in $chatGptMessageCaptureRequiredTokens) {
    if (-not $chatGptMessageCaptureSource.Contains($chatGptMessageCaptureRequiredToken)) {
        throw "ChatGPT message control regression failed: missing token '$chatGptMessageCaptureRequiredToken'."
    }
}

& $node.Source (Join-Path $root 'tool/chatgpt-artifact-guard-regression.mjs')
if ($LASTEXITCODE -ne 0) {
    throw "ChatGPT artifact guard regression failed."
}
& $node.Source (Join-Path $root 'tool/chatgpt-chat-label-regression.mjs')
if ($LASTEXITCODE -ne 0) {
    throw "ChatGPT chat label regression failed."
}
& $node.Source (Join-Path $root 'tool/chatgpt-artifact-expanded-guard-regression.mjs')
if ($LASTEXITCODE -ne 0) {
    throw "expanded ChatGPT artifact guard regression failed."
}
& $node.Source (Join-Path $root 'tool/chatgpt-artifact-boundary-guard-regression.mjs')
if ($LASTEXITCODE -ne 0) {
    throw "boundary ChatGPT artifact guard regression failed."
}
& $node.Source (Join-Path $root 'tests/smoke/chatgpt-output-sanitizer-smoke.mjs')
if ($LASTEXITCODE -ne 0) {
    throw "ChatGPT output sanitizer smoke failed."
}
& $node.Source (Join-Path $root 'tool/oauth-smoke-test.mjs')

$originalAuthMode = $env:CONSOLE_MCP_AUTH_MODE
$originalBearerToken = $env:CONSOLE_MCP_BEARER_TOKEN
$originalTrace = $env:CONSOLE_MCP_TRACE
$originalExtraAllowedRoots = $env:CONSOLE_MCP_EXTRA_ALLOWED_ROOTS
$transcriptDir = Join-Path $root 'var/transcript'
$fixtureDir = Join-Path $root 'var/test-fixtures'
$fixturePath = Join-Path $fixtureDir 'replace-tool.txt'
$httpTracePath = Join-Path $transcriptDir 'http-trace.ndjson'
$falseGreenWorkspace = Join-Path $fixtureDir 'rc-false-green'

if (Test-Path -LiteralPath $httpTracePath) {
    Remove-Item -LiteralPath $httpTracePath -Force
}

New-Item -ItemType Directory -Force -Path $fixtureDir | Out-Null
Set-Content -LiteralPath $fixturePath -Value "alpha`n" -Encoding utf8

if (Test-Path -LiteralPath $falseGreenWorkspace) {
    Remove-Item -LiteralPath $falseGreenWorkspace -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $falseGreenWorkspace | Out-Null
Set-Content -LiteralPath (Join-Path $falseGreenWorkspace 'package.json') -Value @'
{
  "name": "console-mcp-rc-false-green-fixture",
  "private": true,
  "scripts": {
    "build": "node -e \"console.error('Error: synthetic false green'); process.exit(0)\""
  }
}
'@ -Encoding utf8
& (Get-Command git -ErrorAction Stop).Source -C $falseGreenWorkspace init | Out-Null

$portListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
try {
    $portListener.Start()
    $freePort = ([System.Net.IPEndPoint]$portListener.LocalEndpoint).Port
} finally {
    $portListener.Stop()
}

$env:CONSOLE_MCP_HOST = '127.0.0.1'
$env:CONSOLE_MCP_PORT = $freePort.ToString()
$env:CONSOLE_MCP_AUTH_MODE = 'bearer'
$env:CONSOLE_MCP_TRACE = '1'
$token = ([Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N'))
$env:CONSOLE_MCP_BEARER_TOKEN = $token
$env:CONSOLE_MCP_ENDPOINT = "http://127.0.0.1:$freePort/mcp"
$env:CONSOLE_MCP_VEND_WORKSPACE = 'D:\PhpstormProjects\www\Vendoring'
$env:CONSOLE_MCP_WORKSPACE = $root
$env:CONSOLE_MCP_EXTRA_ALLOWED_ROOTS = $env:CONSOLE_MCP_VEND_WORKSPACE
$env:CONSOLE_MCP_FIXTURE_PATH = $fixturePath
$env:CONSOLE_MCP_FALSE_GREEN_WORKSPACE = $falseGreenWorkspace
$env:CONSOLE_MCP_OUTSIDE_PATH = 'D:\ConsoleMcpOutside\blocked.txt'
$env:CONSOLE_MCP_APIKEY_PATH = 'D:\PhpstormProjects\www\Vendoring\src\Service\Security\VendorApiKeyService.php'

$server = Start-Process -FilePath $node.Source -ArgumentList @('--enable-source-maps', 'dist/index.js') -WorkingDirectory $root -PassThru -WindowStyle Hidden
try {
    for ($i = 0; $i -lt 60; $i++) {
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$freePort/mcp" -Method Get -TimeoutSec 2 -SkipHttpErrorCheck -ErrorAction Stop
            if ($response.StatusCode -in 200, 401, 404, 405) {
                break
            }
        } catch {
            $statusCode = $null
            if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
                $statusCode = [int]$_.Exception.Response.StatusCode
            }

            if ($statusCode -in 200, 401, 404, 405) {
                break
            }

            Start-Sleep -Milliseconds 250
        }
    }

    $raw = & $node.Source tool/console-mcp-regression.mjs
    $summary = ($raw -join [Environment]::NewLine) | ConvertFrom-Json

    if ($summary.output_schema_coverage.missing.Count -ne 0) {
        throw "output schema coverage failed: $($summary.output_schema_coverage.missing -join ', ')"
    }
    if ($summary.output_schema_coverage.registered_tool_count -ne $summary.output_schema_coverage.with_output_schema_count) {
        throw "output schema coverage count mismatch."
    }

    foreach ($property in $summary.structured_content.PSObject.Properties) {
        if (-not $property.Value) {
            throw "structured content parity failed for $($property.Name)."
        }
    }

    if ($summary.errors.health) { throw "health tool failed: $($summary.errors.health)" }
    if ($summary.errors.describe) { throw "describe tool failed: $($summary.errors.describe)" }
    if ($summary.errors.workspace_status) { throw "workspace status tool failed: $($summary.errors.workspace_status)" }
    if ($summary.errors.read_file) { throw "read file tool failed: $($summary.errors.read_file)" }
    if ($summary.errors.run_check) { throw "console.run_check failed: $($summary.errors.run_check)" }
    if ($summary.errors.rc_diagnose) { throw "console.rc failed: $($summary.errors.rc_diagnose)" }
    if ($summary.errors.replace_dry_run) { throw "replace text dry-run failed: $($summary.errors.replace_dry_run)" }
    if ($summary.errors.replace_apply) { throw "replace text apply failed: $($summary.errors.replace_apply)" }
    if ($summary.errors.replace_outside) { throw "replace text outside-root check failed: $($summary.errors.replace_outside)" }
    if ($summary.errors.php_lint_changed) { throw "PHP lint changed check failed: $($summary.errors.php_lint_changed)" }

    if (-not $summary.health.ok) { throw "health tool reported non-ok payload." }

    if (-not ($summary.describe.tools -contains 'console.write.repo.file.replace.text')) {
        throw "describe tool list is missing canonical replace text tool."
    }

    if (-not [string]::IsNullOrWhiteSpace($summary.read_file.content)) {
        if ($summary.read_file.content -notmatch 'VendorApiKeyService') {
            throw "read file tool did not return the ApiKey source file."
        }
    } else {
        throw "read file tool returned empty content."
    }

    if ($summary.run_check.check_name -ne 'phpstan') {
        throw "console.run_check did not accept phpstan."
    }

    $rcBlockers = @()
    if ($summary.rc_diagnose.readiness.blockers) {
        $rcBlockers = @($summary.rc_diagnose.readiness.blockers)
    }
    if ($rcBlockers -contains 'workspace_has_uncommitted_changes') {
        throw "console.rc blocked on dirty tree despite allow_existing_readonly."
    }

    if ($summary.errors.rc_false_green) {
        throw "console.rc false-green fixture failed: $($summary.errors.rc_false_green)"
    }
    if ($summary.rc_false_green.ok) {
        throw "console.rc unexpectedly accepted a successful command with serious stderr."
    }
    if ($summary.rc_false_green.validation_results.suspicious_count -lt 1) {
        throw "console.rc false-green fixture did not increment suspicious_count."
    }
    if (-not (@($summary.rc_false_green.readiness.blockers) -contains 'validation_suspicious')) {
        throw "console.rc false-green fixture did not block readiness with validation_suspicious."
    }
    if (-not $summary.rc_false_green.full_execution.proposed_patch_plan.enabled) {
        throw "console.rc full execution did not emit an enabled proposed patch plan."
    }
    if ($summary.rc_false_green.full_execution.proposed_patch_plan.write_policy -ne 'no_file_writes') {
        throw "console.rc full execution proposed patch plan did not stay read-only."
    }
    if ($summary.errors.rc_repair_gate) {
        throw "console.rc repair gate failed: $($summary.errors.rc_repair_gate)"
    }
    if (-not $summary.rc_repair_gate.repair_execution.controlled_loop.enabled) {
        throw "console.rc repair gate did not enable controlled loop with allowed paths and repair limit."
    }
    if ($summary.rc_repair_gate.repair_execution.controlled_loop.executed) {
        throw "console.rc repair gate unexpectedly executed repair work."
    }
    if ($summary.rc_repair_gate.repair_execution.controlled_loop.write_policy -ne 'apply_patch_dry_run_only') {
        throw "console.rc repair gate did not stay in dry-run-only write policy."
    }
    if ($summary.rc_repair_gate.repair_execution.controlled_loop.dry_run_patch_request.tool -ne 'console.write.repo.patch.apply') {
        throw "RC repair gate did not emit a canonical patch dry-run request proposal."
    }
    if (-not $summary.rc_repair_gate.repair_execution.controlled_loop.dry_run_patch_request.arguments.dryRun) {
        throw "console.rc repair gate dry-run request proposal did not set dryRun=true."
    }
    $repairPatchBody = [string]$summary.rc_repair_gate.repair_execution.controlled_loop.dry_run_patch_request.patch_body
    $patchPrefix = 'diff --' + 'git'
    if (-not $repairPatchBody.StartsWith($patchPrefix)) {
        throw "console.rc repair gate did not emit a concrete unified diff patch body."
    }
    if (-not $summary.rc_repair_gate.repair_execution.controlled_loop.dry_run_result.dry_run) {
        throw "console.rc repair gate did not execute the controlled dry-run boundary."
    }
    if ($summary.rc_repair_gate.repair_execution.controlled_loop.dry_run_result.applied) {
        throw "console.rc repair gate unexpectedly applied a patch."
    }
    if ($summary.rc_repair_gate.repair_execution.controlled_loop.dry_run_classification.status -ne 'applicable') {
        $dryRunDebug = $summary.rc_repair_gate.repair_execution.controlled_loop | ConvertTo-Json -Depth 20 -Compress
        throw "console.rc repair gate did not classify applicable dry-run result: $dryRunDebug"
    }
    if (-not $summary.rc_repair_gate.repair_execution.controlled_loop.dry_run_classification.can_request_apply_approval) {
        throw "console.rc repair gate did not mark applicable dry-run as approval-ready."
    }
    if (-not $summary.rc_repair_gate.repair_execution.controlled_loop.apply_approval_request.enabled) {
        throw "console.rc repair gate did not expose apply approval request after applicable dry-run."
    }
    if (-not $summary.rc_repair_gate.repair_execution.controlled_loop.apply_result.skipped) {
        throw "console.rc repair gate applied without explicit approval."
    }
    if ($summary.errors.rc_repair_approved) {
        throw "console.rc approved repair failed: $($summary.errors.rc_repair_approved)"
    }
    if (-not $summary.rc_repair_approved.repair_execution.controlled_loop.apply_result.applied) {
        throw "console.rc approved repair did not apply the temporary fixture patch."
    }
    if (-not $summary.rc_repair_approved.repair_execution.controlled_loop.post_apply_validation_result.ok) {
        throw "console.rc approved repair did not revalidate successfully after applying the temporary fixture patch."
    }
    if ($summary.rc_repair_gate.repair_execution.controlled_loop.post_apply_validation_result.skipped -ne $true) {
        throw "console.rc repair gate did not skip revalidation before apply."
    }
    if (-not $summary.rc_repair_approved.repair_execution.controlled_loop.vcs_gate.eligible) {
        throw "console.rc approved repair did not expose green VCS gate."
    }
    if ($summary.rc_repair_approved.repair_execution.controlled_loop.vcs_gate.execute_automatically) {
        throw "console.rc approved repair unexpectedly enabled automatic VCS action."
    }
    if ($summary.rc_repair_gate.repair_execution.controlled_loop.vcs_gate.eligible) {
        throw "console.rc repair gate exposed VCS eligibility without apply and recheck."
    }
    if (-not $summary.rc_repair_approved.stage_artifact_write.written) {
        throw "console.rc approved repair did not write stage evidence."
    }
    if (-not $summary.rc_repair_approved.stage_artifact_write.repair_chain.applied) {
        throw "console.rc approved repair stage evidence did not record applied repair."
    }
    if (-not $summary.rc_repair_approved.stage_artifact_write.repair_chain.save_eligible) {
        throw "console.rc approved repair stage evidence did not record save eligibility."
    }

    if (-not $summary.replace_dry_run.dry_run -or -not $summary.replace_dry_run.applicable) {
        throw "replace text dry-run did not report applicability."
    }

    if (-not $summary.replace_apply.applied) {
        throw "replace text apply did not report applied=true."
    }

    $fixtureContent = Get-Content -LiteralPath $fixturePath -Raw
    if ($fixtureContent -notmatch 'beta') {
        throw "replace_in_file did not update the fixture content."
    }

    if ($summary.replace_outside.ok) {
        throw "replace_in_file unexpectedly accepted an out-of-root path."
    }

    if (-not ($summary.php_lint_changed.PSObject.Properties.Name -contains 'ok')) {
        throw "PHP lint changed payload is missing ok."
    }

    Write-Output ($summary | ConvertTo-Json -Depth 20)
} finally {
    if ($server -and -not $server.HasExited) {
        Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    }

    if (Test-Path -LiteralPath $fixturePath) {
        Remove-Item -LiteralPath $fixturePath -Force -ErrorAction SilentlyContinue
    }

    if ($null -ne $originalBearerToken) {
        $env:CONSOLE_MCP_BEARER_TOKEN = $originalBearerToken
    } else {
        Remove-Item Env:CONSOLE_MCP_BEARER_TOKEN -ErrorAction SilentlyContinue
    }

    if ($null -ne $originalAuthMode) {
        $env:CONSOLE_MCP_AUTH_MODE = $originalAuthMode
    } else {
        Remove-Item Env:CONSOLE_MCP_AUTH_MODE -ErrorAction SilentlyContinue
    }

    if ($null -ne $originalTrace) {
        $env:CONSOLE_MCP_TRACE = $originalTrace
    } else {
        Remove-Item Env:CONSOLE_MCP_TRACE -ErrorAction SilentlyContinue
    }

    if ($null -ne $originalExtraAllowedRoots) {
        $env:CONSOLE_MCP_EXTRA_ALLOWED_ROOTS = $originalExtraAllowedRoots
    } else {
        Remove-Item Env:CONSOLE_MCP_EXTRA_ALLOWED_ROOTS -ErrorAction SilentlyContinue
    }
}

