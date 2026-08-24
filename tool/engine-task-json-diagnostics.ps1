$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$taskDir = Join-Path $root 'var/run/engine/task'

$results = @()
Get-ChildItem -LiteralPath $taskDir -Filter '*.json' -File | Sort-Object Name | ForEach-Object {
    $file = $_
    $raw = Get-Content -Raw -LiteralPath $file.FullName
    try {
        $null = $raw | ConvertFrom-Json -ErrorAction Stop
        $results += [pscustomobject]@{
            file = $file.Name
            valid = $true
            length = $file.Length
        }
    } catch {
        $results += [pscustomobject]@{
            file = $file.Name
            valid = $false
            length = $file.Length
            error = $_.Exception.Message
        }
    }
}

$invalid = @($results | Where-Object { -not $_.valid })
[pscustomobject]@{
    total = $results.Count
    invalid_count = $invalid.Count
    invalid = $invalid
} | ConvertTo-Json -Depth 5

