$ErrorActionPreference = 'Stop'
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-contained-process.cs')
    $config = [Console]::ReadLine() | ConvertFrom-Json
    $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($property in $config.env.psobject.Properties) { $environment[$property.Name] = [string]$property.Value }
    exit [RuntimeContainment.Host]::Run([string]$config.executable, [string[]]$config.arguments,
        [string]$config.cwd, $environment, [ulong]$config.memoryBytes)
} catch {
    [Console]::Error.WriteLine('{"containment":"failed"}')
    exit 78
}
