$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$npm = Get-Command npm -ErrorAction Stop
$node = Get-Command node -ErrorAction Stop

if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules'))) {
    & $npm.Source install
}

& $npm.Source run build
& $node.Source (Join-Path $root 'tool/oauth-smoke-test.mjs')

$originalAuthMode = $env:CONSOLE_MCP_AUTH_MODE
$originalBearerToken = $env:CONSOLE_MCP_BEARER_TOKEN
$originalTrace = $env:CONSOLE_MCP_TRACE
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

    if ($summary.errors.health) { throw "console.health failed: $($summary.errors.health)" }
    if ($summary.errors.describe) { throw "console.describe failed: $($summary.errors.describe)" }
    if ($summary.errors.workspace_status) { throw "console.workspace_status failed: $($summary.errors.workspace_status)" }
    if ($summary.errors.read_file) { throw "console.read_file failed: $($summary.errors.read_file)" }
    if ($summary.errors.run_check) { throw "console.run_check failed: $($summary.errors.run_check)" }
    if ($summary.errors.rc_diagnose) { throw "console.rc failed: $($summary.errors.rc_diagnose)" }
    if ($summary.errors.replace_dry_run) { throw "console.replace_in_file dry-run failed: $($summary.errors.replace_dry_run)" }
    if ($summary.errors.replace_apply) { throw "console.replace_in_file apply failed: $($summary.errors.replace_apply)" }
    if ($summary.errors.replace_outside) { throw "console.replace_in_file outside-root check failed: $($summary.errors.replace_outside)" }
    if ($summary.errors.php_lint_changed) { throw "console.php_lint_changed failed: $($summary.errors.php_lint_changed)" }

    if (-not $summary.health.ok) { throw "console.health reported non-ok payload." }

    if (-not ($summary.describe.tools -contains 'console.replace_in_file')) {
        throw "console.describe tool list is missing console.replace_in_file."
    }

    if (-not [string]::IsNullOrWhiteSpace($summary.read_file.content)) {
        if ($summary.read_file.content -notmatch 'VendorApiKeyService') {
            throw "console.read_file did not return the ApiKey source file."
        }
    } else {
        throw "console.read_file returned empty content."
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
    if ($summary.rc_repair_gate.repair_execution.controlled_loop.dry_run_patch_request.tool -ne 'console.apply_patch') {
        throw "console.rc repair gate did not emit an apply_patch dry-run request proposal."
    }
    if (-not $summary.rc_repair_gate.repair_execution.controlled_loop.dry_run_patch_request.arguments.dryRun) {
        throw "console.rc repair gate dry-run request proposal did not set dryRun=true."
    }
    $repairPatchBody = [string]$summary.rc_repair_gate.repair_execution.controlled_loop.dry_run_patch_request.patch_body
    $patchPrefix = 'diff --' + 'git'
    if (-not $repairPatchBody.StartsWith($patchPrefix)) {
        throw "console.rc repair gate did not emit a concrete unified diff patch body."
    }

    if (-not $summary.replace_dry_run.dry_run -or -not $summary.replace_dry_run.applicable) {
        throw "console.replace_in_file dry-run did not report applicability."
    }

    if (-not $summary.replace_apply.applied) {
        throw "console.replace_in_file apply did not report applied=true."
    }

    $fixtureContent = Get-Content -LiteralPath $fixturePath -Raw
    if ($fixtureContent -notmatch 'beta') {
        throw "replace_in_file did not update the fixture content."
    }

    if ($summary.replace_outside.ok) {
        throw "replace_in_file unexpectedly accepted an out-of-root path."
    }

    if (-not ($summary.php_lint_changed.PSObject.Properties.Name -contains 'ok')) {
        throw "console.php_lint_changed payload is missing ok."
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
}
