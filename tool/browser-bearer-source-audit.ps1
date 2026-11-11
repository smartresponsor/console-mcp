$ErrorActionPreference = 'Stop'
$env:AWS_PAGER=''
$env:AWS_EC2_METADATA_DISABLED='true'
$env:AWS_MAX_ATTEMPTS='1'
$env:AWS_RETRY_MODE='standard'
$env:AWS_CLI_AUTO_PROMPT='off'
$env:AWS_DEFAULT_OUTPUT='json'
$awsBinary=(Get-Command aws -ErrorAction SilentlyContinue)
$profiles = if($awsBinary){@(& $awsBinary.Source configure list-profiles 2>$null)}else{@()}
$configuredRegion=if($awsBinary){@(& $awsBinary.Source configure get region 2>$null) | Select-Object -First 1}else{$null}
$profile = if($env:AWS_PROFILE){'env-selected'}elseif($env:AWS_DEFAULT_PROFILE){'env-default'}else{'default'}
$awsConfigExists=(Test-Path (Join-Path $HOME '.aws/config') -PathType Leaf)
$awsCredentialsExists=(Test-Path (Join-Path $HOME '.aws/credentials') -PathType Leaf)
$stsStatus='NOT_ATTEMPTED'
$stsErrorClass=$null
try {
  if(-not $awsBinary){throw 'AWS_CLI_MISSING'}
  $output = @(& /usr/bin/timeout 12 $awsBinary.Source sts get-caller-identity --query Account --output text --no-cli-pager 2>&1)
  if($LASTEXITCODE -eq 0 -and $output.Count -gt 0){$stsStatus='IDENTITY_ACCESS_OK'}
  elseif($LASTEXITCODE -eq 124){$stsStatus='TIMEOUT'}
  else{ $stsStatus='IDENTITY_ACCESS_FAILED'; $joined=($output | Out-String); if($joined -match 'Unable to locate credentials'){$stsErrorClass='NO_CREDENTIALS'}elseif($joined -match 'You must specify a region'){$stsErrorClass='REGION_MISSING'}elseif($joined -match 'ExpiredToken'){$stsErrorClass='EXPIRED_TOKEN'}elseif($joined -match 'AccessDenied'){$stsErrorClass='ACCESS_DENIED'}else{$stsErrorClass='OTHER_REDACTED'} }
} catch { $stsStatus='ERROR'; $stsErrorClass=$_.Exception.GetType().Name }
[pscustomobject]@{
  status='BEARER_SOURCE_PREREQUISITES'
  processTokenConfigured=(-not [string]::IsNullOrWhiteSpace($env:CONSOLE_MCP_BEARER_TOKEN))
  secretIdOverrideConfigured=(-not [string]::IsNullOrWhiteSpace($env:CONSOLE_MCP_BEARER_SECRET_ID))
  awsCliAvailable=[bool]$awsBinary
  profileSelection=$profile
  anyProfiles=($profiles.Count -gt 0)
  regionConfigured=(-not [string]::IsNullOrWhiteSpace($configuredRegion) -or -not [string]::IsNullOrWhiteSpace($env:AWS_REGION) -or -not [string]::IsNullOrWhiteSpace($env:AWS_DEFAULT_REGION))
  configFilePresent=$awsConfigExists
  credentialsFilePresent=$awsCredentialsExists
  stsStatus=$stsStatus
  stsErrorClass=$stsErrorClass
  secretReadAttempted=$false
  codexRunAttempted=$false
} | ConvertTo-Json -Compress
