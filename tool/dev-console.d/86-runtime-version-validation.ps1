function Invoke-RuntimeVersionValidation {
    # Opt-in broker action. Never reads or writes the production selector/ports.
    $configPath = Join-Path $RunDir 'runtime-version-validation.json'
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw 'VERSION_VALIDATION_NOT_CONFIGURED' }
    $session = (Get-Process -Id $PID -ErrorAction Stop).SessionId
    if ($session -le 0) { throw 'VERSION_VALIDATION_INTERACTIVE_SESSION_REQUIRED' }
    $console = Get-ConsoleSessionReport
    if (-not $console.active_console -or $console.active_console.id -ne $session) { throw 'VERSION_VALIDATION_ACTIVE_CONSOLE_REQUIRED' }
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($config.mode -ne 'isolated-validation' -or $config.expectedSessionId -ne $session) { throw 'VERSION_VALIDATION_SESSION_MISMATCH' }
    $node = (Get-NodeCommand).Source
    $raw = & $node (Join-Path $Root 'tool/runtime-watchdog-validation.mjs') $configPath
    if ($LASTEXITCODE -ne 0) { throw 'VERSION_VALIDATION_FAILED' }
    return ($raw | Out-String | ConvertFrom-Json)
}
