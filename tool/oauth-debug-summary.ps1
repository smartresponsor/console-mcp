param([string]$LogPath = '', [int]$Tail = 200)
if (-not $LogPath) { $LogPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'var/transcript/oauth-debug.ndjson' }
$ErrorActionPreference = 'Stop'
if ($Tail -lt 1 -or $Tail -gt 2000) { throw 'Tail must be 1..2000' }
if (-not (Test-Path -LiteralPath $LogPath -PathType Leaf)) { throw 'OAuth debug log unavailable' }
$rows = @(Get-Content -LiteralPath $LogPath -Tail $Tail -ErrorAction Stop)
$parsed = @()
$invalid = 0
foreach ($line in $rows) {
  try {
    $item = $line | ConvertFrom-Json -ErrorAction Stop
    $message = [string]$item.error_message
    $failureClass = if ($item.result -ne 'failure') { 'none' } elseif ($message -match 'expired|exp claim') { 'expired' } elseif ($message -match 'audience|aud claim') { 'audience' } elseif ($message -match 'issuer|iss claim') { 'issuer' } elseif ($message -match 'signature|verification failed') { 'signature' } elseif ($message -match 'JWKS|JWK|key') { 'key_resolution' } elseif ($message -match 'claim|unexpected|invalid JWT') { 'claim_validation' } elseif ($message -match 'compact|malformed|format') { 'malformed_token' } else { 'other' }
    $fingerprint = if ($item.result -eq 'failure') { $bytes=[System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($message)); [Convert]::ToHexString($bytes).Substring(0,12) } else { 'none' }
    $parsed += [pscustomobject]@{ timestamp = $item.timestamp; result = $item.result; failure_stage = $item.failure_stage; failure_class=$failureClass; error_fingerprint=$fingerprint }
  } catch { $invalid++ }
}
$grouped = @($parsed | Group-Object result,failure_stage,failure_class,error_fingerprint | ForEach-Object { [pscustomobject]@{ category = $_.Name; count = $_.Count } })
$window = @($parsed | Where-Object { $_.timestamp -ge '2026-11-12T20:02:45' -and $_.timestamp -le '2026-11-12T20:03:10' } | Group-Object result,failure_stage,failure_class,error_fingerprint | ForEach-Object { [pscustomobject]@{ category=$_.Name; count=$_.Count } })
[pscustomobject]@{ sampled_lines = $rows.Count; parsed = $parsed.Count; invalid = $invalid; first_timestamp = $(if ($parsed.Count) { $parsed[0].timestamp } else { $null }); last_timestamp = $(if ($parsed.Count) { $parsed[-1].timestamp } else { $null }); grouped = $grouped; investigation_window=$window } | ConvertTo-Json -Depth 5
