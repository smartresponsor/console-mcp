$ErrorActionPreference = 'Stop'
$units = @('console-mcp.service', 'console-mcp-release-broker.service')
$results = foreach ($unit in $units) {
  $properties = @{}
  $raw = & systemctl show $unit --property=LoadState,ActiveState,MainPID,User,FragmentPath,DropInPaths,EnvironmentFiles,Environment --no-pager 2>$null
  foreach ($line in $raw) {
    $index = $line.IndexOf('=')
    if ($index -gt 0) { $properties[$line.Substring(0,$index)] = $line.Substring($index+1) }
  }
  $environment = [string]$properties['Environment']
  [pscustomobject]@{
    unit = $unit
    loaded = $properties['LoadState']
    active = $properties['ActiveState']
    main_pid_present = ($properties['MainPID'] -match '^[1-9][0-9]*$')
    user_configured = -not [string]::IsNullOrWhiteSpace($properties['User'])
    environment_file_declared = -not [string]::IsNullOrWhiteSpace($properties['EnvironmentFiles'])
    aws_region_in_unit_environment = ($environment -match '(?:^|\s)AWS_(?:DEFAULT_)?REGION=')
    aws_profile_in_unit_environment = ($environment -match '(?:^|\s)AWS_(?:DEFAULT_)?PROFILE=')
    aws_credentials_in_unit_environment = ($environment -match '(?:^|\s)AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|WEB_IDENTITY_TOKEN_FILE|ROLE_ARN)=')
    dropin_present = -not [string]::IsNullOrWhiteSpace($properties['DropInPaths'])
  }
}
$results | ConvertTo-Json -Depth 4
