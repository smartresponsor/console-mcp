$ErrorActionPreference = 'Stop'
$unit = 'console-mcp.service'
$serviceUser = [string](& systemctl show $unit -p User --value)
$passwd = (& getent passwd $serviceUser 2>$null)
$homePath = if ($passwd) { ([string]$passwd -split ':')[5] } else { '' }
$configuration = @()
foreach ($name in @('config','credentials')) {
  $path = if ($homePath) { Join-Path $homePath ".aws/$name" } else { '' }
  $exists = $false; $readable = $false; $sections = @()
  if ($path -and (Test-Path -LiteralPath $path -PathType Leaf)) {
    $exists = $true
    try {
      foreach ($line in [System.IO.File]::ReadAllLines($path)) {
        if ($line -match '^\s*\[([^\]]+)\]') {
          $section = [string]$Matches[1]
          $sections += if ($section -eq 'default') { 'default' } else { 'named-profile' }
        }
      }
      $readable = $true
    } catch { }
  }
  $configuration += @{ file_kind = $name; exists = $exists; readable = $readable; profile_sections = @($sections | Sort-Object -Unique) }
}
@{ service_user_present = [bool]$serviceUser; home_resolved = [bool]$homePath; configuration = $configuration; credentials_disclosed = $false } | ConvertTo-Json -Depth 5
