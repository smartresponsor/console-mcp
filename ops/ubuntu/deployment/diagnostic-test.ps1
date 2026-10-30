$ErrorActionPreference = 'Stop'
function query { throw 'Windows query invoked on Linux' }
function Sanitize-Text($v) { $v }
. '/home/alex/smartresponse/mcp/console-mcp/tool/dev-console.d/20-browser-health.ps1'
. '/home/alex/smartresponse/mcp/console-mcp/tool/dev-console.d/50-desktop-session.ps1'
$a = Get-InteractiveConsoleSessionReport
$b = Get-ConsoleSessionReport
if ($a.status -ne 'WINDOWS_CONSOLE_QUERY_NOT_APPLICABLE' -or $b.status -ne 'WINDOWS_CONSOLE_QUERY_NOT_APPLICABLE') { throw 'Platform guard failed' }
if ($a.user_interaction_ready -or $b.user_interaction_ready -or $a.visibility_verified -or $b.visibility_verified) { throw 'False readiness' }
'LINUX_DIAGNOSTIC_GUARDS_PASS'
