$ErrorActionPreference = 'Stop'
$unit = 'console-mcp.service'
$mainPid = [string](& systemctl show $unit -p MainPID --value)
$filesSpec = [string](& systemctl show $unit -p EnvironmentFiles --value)
$names = @('AWS_REGION','AWS_DEFAULT_REGION','AWS_PROFILE','AWS_DEFAULT_PROFILE','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','AWS_ROLE_ARN','AWS_WEB_IDENTITY_TOKEN_FILE','AWS_SHARED_CREDENTIALS_FILE','AWS_CONFIG_FILE','CONSOLE_MCP_BEARER_SECRET_ID')
$fileNames = @()
$fileAccessible = $false
foreach ($entry in ($filesSpec -split '\s+')) {
  if (-not $entry) { continue }
  $path = ($entry -replace '^\-','' -replace '\(.*$','')
  if (-not $path.StartsWith('/')) { continue }
  if (Test-Path -LiteralPath $path -PathType Leaf) {
    try {
      $lines = [System.IO.File]::ReadAllLines($path)
      $fileAccessible = $true
      foreach ($line in $lines) {
        if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=') {
          if ($names -contains $Matches[1]) { $fileNames += $Matches[1] }
        }
      }
    } catch { }
  }
}
$processAccessible = $false
$processNames = @()
if ($mainPid -match '^[1-9][0-9]*$') {
  try {
    $bytes = [System.IO.File]::ReadAllBytes("/proc/$mainPid/environ")
    $processAccessible = $true
    foreach ($entry in ([System.Text.Encoding]::UTF8.GetString($bytes) -split [char]0)) {
      $key = ($entry -split '=',2)[0]
      if ($names -contains $key) { $processNames += $key }
    }
  } catch { }
}
@{ unit = $unit; environment_file_declared = [bool]$filesSpec; environment_file_readable = $fileAccessible; environment_file_aws_names = @($fileNames | Sort-Object -Unique); process_environment_readable = $processAccessible; process_aws_names = @($processNames | Sort-Object -Unique); values_disclosed = $false } | ConvertTo-Json -Depth 4
