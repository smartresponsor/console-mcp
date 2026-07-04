function New-StackOperationId {
    param([string]$Purpose = 'manual')
    return ((Get-Date).ToString('yyyyMMdd-HHmmss-fff') + '-' + ($Purpose -replace '[^A-Za-z0-9_.-]', '-'))
}

function Write-StateArtifact {
    param([string]$Directory, [string]$Name, [object]$Payload)
    New-Item -ItemType Directory -Force -Path $Directory | Out-Null
    $path = Join-Path $Directory ($Name + '.json')
    $Payload | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $path -Encoding utf8
    return $path
}

Set-Variable -Name DevConsoleStateModuleLoaded -Scope Script -Value $true -Force
