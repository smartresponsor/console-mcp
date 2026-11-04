$ErrorActionPreference = 'Stop'
$env:AWS_PAGER = ''
function Test-AwsRead {
    param([string[]]$AwsArguments)
    try {
        $output = & aws @AwsArguments --output json --no-cli-pager 2>&1
        if ($LASTEXITCODE -eq 0) { return @{ ok = $true; status = 'OK' } }
        $message = [string]($output -join ' ')
        if ($message -match 'NoRegion|specify a region') { return @{ ok = $false; status = 'NO_REGION' } }
        if ($message -match 'Unable to locate credentials|NoCredentials') { return @{ ok = $false; status = 'NO_CREDENTIALS' } }
        if ($message -match 'AccessDenied|UnauthorizedOperation') { return @{ ok = $false; status = 'ACCESS_DENIED' } }
        if ($message -match 'ResourceNotFound') { return @{ ok = $false; status = 'RESOURCE_NOT_FOUND' } }
        return @{ ok = $false; status = 'AWS_REQUEST_FAILED' }
    } catch { return @{ ok = $false; status = 'AWS_CLI_UNAVAILABLE_OR_FAILED' } }
}
$region = [bool]($env:AWS_REGION -or $env:AWS_DEFAULT_REGION)
$profile = [bool]($env:AWS_PROFILE -or $env:AWS_DEFAULT_PROFILE)
$identity = Test-AwsRead -AwsArguments @('sts', 'get-caller-identity')
$secretId = if ($env:CONSOLE_MCP_BEARER_SECRET_ID) { $env:CONSOLE_MCP_BEARER_SECRET_ID } else { '/secret/dev/console-mcp/bearer-token' }
$secret = if ($identity.ok) { Test-AwsRead -AwsArguments @('secretsmanager', 'describe-secret', '--secret-id', $secretId) } else { @{ ok = $false; status = 'NOT_CHECKED' } }
@{ region_environment_configured = $region; profile_environment_configured = $profile; identity = $identity; secret_metadata = $secret; secret_value_read = $false } | ConvertTo-Json -Depth 5
