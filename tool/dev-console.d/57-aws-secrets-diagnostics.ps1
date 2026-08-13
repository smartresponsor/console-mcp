function Resolve-AwsCliForDiagnostics {
    return (Get-Command aws -ErrorAction Stop).Source
}

function Invoke-AwsCliForDiagnostics {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [int[]]$AllowedExitCodes = @(0)
    )

    $aws = Resolve-AwsCliForDiagnostics
    $output = & $aws @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    $text = (($output | Out-String).Trim())

    return [pscustomobject]@{
        ok = $AllowedExitCodes -contains $exitCode
        exit_code = $exitCode
        output = Sanitize-Text $text
    }
}

function ConvertFrom-AwsJsonOutput {
    param([string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return $null
    }

    return ($Text | ConvertFrom-Json)
}

function Show-AwsStatus {
    $version = Invoke-AwsCliForDiagnostics -Arguments @('--version')
    $identity = Invoke-AwsCliForDiagnostics -Arguments @('sts', 'get-caller-identity', '--output', 'json')
    $region = Invoke-AwsCliForDiagnostics -Arguments @('configure', 'get', 'region') -AllowedExitCodes @(0, 1)
    $configure = Invoke-AwsCliForDiagnostics -Arguments @('configure', 'list')

    $identityObject = $null
    if ($identity.ok) {
        try {
            $identityObject = ConvertFrom-AwsJsonOutput -Text $identity.output
        } catch {
            $identityObject = $null
        }
    }

    [pscustomobject]@{
        ok = [bool]($version.ok -and $identity.ok -and $configure.ok)
        status = if ($version.ok -and $identity.ok -and $configure.ok) { 'AWS_STATUS_AVAILABLE' } else { 'AWS_STATUS_UNAVAILABLE' }
        aws_version = $version.output
        caller_identity = $identityObject
        region = if ($region.ok -and -not [string]::IsNullOrWhiteSpace($region.output)) { $region.output } else { $null }
        configure = $configure.output
        diagnostics = [pscustomobject]@{
            version_exit_code = $version.exit_code
            identity_exit_code = $identity.exit_code
            region_exit_code = $region.exit_code
            configure_exit_code = $configure.exit_code
            identity_error = if ($identity.ok) { $null } else { $identity.output }
            configure_error = if ($configure.ok) { $null } else { $configure.output }
        }
    } | ConvertTo-Json -Depth 10
}

function Show-AwsQodanaSecretsStatus {
    $query = "SecretList[?starts_with(Name, 'smartresponsor/qodana/')].{Name:Name,LastChangedDate:LastChangedDate,LastAccessedDate:LastAccessedDate}"
    $result = Invoke-AwsCliForDiagnostics -Arguments @(
        'secretsmanager',
        'list-secrets',
        '--query',
        $query,
        '--output',
        'json'
    )

    $secrets = @()
    $parseError = $null
    if ($result.ok) {
        try {
            $parsed = ConvertFrom-AwsJsonOutput -Text $result.output
            if ($null -ne $parsed) {
                $secrets = @($parsed)
            }
        } catch {
            $parseError = Sanitize-Text $_.Exception.Message
        }
    }

    [pscustomobject]@{
        ok = [bool]($result.ok -and -not $parseError)
        status = if ($result.ok -and -not $parseError) { 'AWS_QODANA_SECRET_LIST_AVAILABLE' } else { 'AWS_QODANA_SECRET_LIST_UNAVAILABLE' }
        prefix = 'smartresponsor/qodana/'
        count = @($secrets).Count
        secrets = $secrets
        diagnostic = if ($result.ok) { $parseError } else { $result.output }
    } | ConvertTo-Json -Depth 10
}

function Get-AwsQodanaSecretMetadata {
    param([string]$SecretId = 'smartresponsor/qodana/App')

    $query = '{Name:Name,VersionId:VersionId,CreatedDate:CreatedDate,VersionStages:VersionStages}'
    $result = Invoke-AwsCliForDiagnostics -Arguments @(
        'secretsmanager',
        'get-secret-value',
        '--secret-id',
        $SecretId,
        '--query',
        $query,
        '--output',
        'json'
    )

    if (-not $result.ok) {
        return [pscustomobject]@{
            ok = $false
            metadata = $null
            diagnostic = $result.output
        }
    }

    try {
        return [pscustomobject]@{
            ok = $true
            metadata = ConvertFrom-AwsJsonOutput -Text $result.output
            diagnostic = $null
        }
    } catch {
        return [pscustomobject]@{
            ok = $false
            metadata = $null
            diagnostic = Sanitize-Text $_.Exception.Message
        }
    }
}

function Get-AwsQodanaSecretShape {
    param([string]$SecretId = 'smartresponsor/qodana/App')

    $result = Invoke-AwsCliForDiagnostics -Arguments @(
        'secretsmanager',
        'get-secret-value',
        '--secret-id',
        $SecretId,
        '--query',
        'SecretString',
        '--output',
        'text'
    )

    if (-not $result.ok) {
        return [pscustomobject]@{
            ok = $false
            has_value = $false
            length = 0
            json_valid = $false
            has_qodana_token = $false
            has_endpoint = $false
            storage_format = 'unavailable'
            diagnostic = $result.output
        }
    }

    $secretText = [string]$result.output
    $hasValue = -not [string]::IsNullOrWhiteSpace($secretText) -and $secretText -ne 'None'
    $jsonValid = $false
    $hasQodanaToken = $false
    $hasEndpoint = $false
    $storageFormat = if ($hasValue) { 'string' } else { 'empty' }

    if ($hasValue -and $secretText.TrimStart().StartsWith('{')) {
        try {
            $json = $secretText | ConvertFrom-Json
            $jsonValid = $true
            $storageFormat = 'json'
            $propertyNames = @($json.PSObject.Properties.Name)
            $hasQodanaToken = [bool]($propertyNames -contains 'QODANA_TOKEN' -and -not [string]::IsNullOrWhiteSpace([string]$json.QODANA_TOKEN))
            $hasEndpoint = [bool]($propertyNames -contains 'QODANA_ENDPOINT' -and -not [string]::IsNullOrWhiteSpace([string]$json.QODANA_ENDPOINT))
        } catch {
            $jsonValid = $false
            $storageFormat = 'invalid-json'
        }
    }

    return [pscustomobject]@{
        ok = $hasValue
        has_value = $hasValue
        length = $secretText.Length
        json_valid = $jsonValid
        has_qodana_token = $hasQodanaToken
        has_endpoint = $hasEndpoint
        storage_format = $storageFormat
        diagnostic = $null
    }
}

function Show-AwsQodanaSecretCheck {
    $secretId = 'smartresponsor/qodana/App'
    $metadata = Get-AwsQodanaSecretMetadata -SecretId $secretId
    $shape = Get-AwsQodanaSecretShape -SecretId $secretId

    [pscustomobject]@{
        ok = [bool]($metadata.ok -and $shape.ok)
        status = if ($metadata.ok -and $shape.ok) { 'AWS_QODANA_SECRET_AVAILABLE' } else { 'AWS_QODANA_SECRET_UNAVAILABLE' }
        secret_id = $secretId
        metadata = $metadata.metadata
        shape = $shape
        diagnostics = [pscustomobject]@{
            metadata = $metadata.diagnostic
            shape = $shape.diagnostic
        }
    } | ConvertTo-Json -Depth 10
}
