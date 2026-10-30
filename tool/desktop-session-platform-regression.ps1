$ErrorActionPreference = 'Stop'
# Isolate the Linux branch in this process; native queries must never execute.
Set-Variable -Name IsWindows -Value $false -Force -Scope Script
function query { throw 'Windows session query was invoked on Linux' }
function Get-CimInstance { throw 'Windows CIM was invoked on Linux' }
. (Join-Path $PSScriptRoot 'dev-console.d/20-browser-health.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/50-desktop-session.ps1')
$health = Get-InteractiveConsoleSessionReport
$session = Get-ConsoleSessionReport
if ($health.status -ne 'WINDOWS_CONSOLE_QUERY_NOT_APPLICABLE' -or $health.authoritative_source -ne 'linux_desktop_agent') {
    throw 'Linux desktop eligibility must be delegated to its desktop agent'
}
if ($session.status -ne 'WINDOWS_CONSOLE_QUERY_NOT_APPLICABLE' -or $session.reasons -notcontains 'use_linux_desktop_agent') {
    throw 'Linux session diagnostics must provide actionable platform evidence'
}
foreach ($result in @($health, $session)) {
    if ($result.visibility_verified -or $result.user_interaction_ready) { throw 'Platform diagnostics cannot authorize interaction' }
}
if ($health.has_active_console -or $session.ok -or $session.session_count -ne 0) {
    throw 'Windows session evidence must not be inferred on Linux'
}
Write-Output 'DESKTOP_SESSION_PLATFORM_REGRESSION_PASS'
