$ErrorActionPreference = 'Stop'
$result = [ordered]@{}
foreach ($name in @('gitleaks','semgrep')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($null -eq $cmd) {
        $result[$name] = @{ installed = $false }
        continue
    }
    $version = try { (& $cmd.Source --version 2>&1 | Select-Object -First 3) -join ' ' } catch { $_.Exception.Message }
    $result[$name] = @{
        installed = $true
        path = $cmd.Source
        version = $version
    }
}
$result | ConvertTo-Json -Depth 5
$self = $PSCommandPath
Start-Sleep -Milliseconds 100
