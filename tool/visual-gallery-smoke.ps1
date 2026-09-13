[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $repoRoot)
$artifactRoot = Join-Path $workspaceRoot 'var'
$component = 'GallerySmoke'
$now = Get-Date
$date = $now.ToString('yyyy-MM-dd')
$runId = 'run-' + $now.ToString('HH-mm-ss')
$runRoot = Join-Path $artifactRoot (Join-Path $component (Join-Path $date $runId))
$screenshots = Join-Path $runRoot 'screenshots\web\unspecified'
$todayRoot = Join-Path $artifactRoot (Join-Path $component 'today')

New-Item -ItemType Directory -Force -Path $screenshots | Out-Null
New-Item -ItemType Directory -Force -Path $todayRoot | Out-Null

Add-Type -AssemblyName System.Drawing
$imagePath = Join-Path $screenshots 'gallery-smoke.png'
$bitmap = [System.Drawing.Bitmap]::new(1200, 700)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
    $graphics.Clear([System.Drawing.Color]::White)
    $titleFont = [System.Drawing.Font]::new('Segoe UI', 38, [System.Drawing.FontStyle]::Bold)
    $bodyFont = [System.Drawing.Font]::new('Segoe UI', 22, [System.Drawing.FontStyle]::Regular)
    try {
        $graphics.DrawString('Visual Gallery Smoke Test', $titleFont, [System.Drawing.Brushes]::Black, 70, 90)
        $graphics.DrawString('If you can open this image on iPhone through Tailscale, the artifact transport works end-to-end.', $bodyFont, [System.Drawing.Brushes]::Black, 70, 190)
        $graphics.DrawString(('Created: ' + $now.ToString('yyyy-MM-dd HH:mm:ss')), $bodyFont, [System.Drawing.Brushes]::Black, 70, 280)
        $graphics.DrawString('Component: GallerySmoke', $bodyFont, [System.Drawing.Brushes]::Black, 70, 340)
    } finally {
        $titleFont.Dispose()
        $bodyFont.Dispose()
    }
    $bitmap.Save($imagePath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    $graphics.Dispose()
    $bitmap.Dispose()
}

[ordered]@{
    schema = 'visual-artifact-run-v1'
    component = $component
    date = $date
    run_id = $runId
    producer = 'gallery-smoke'
    platform = 'web'
    cohort = 'unspecified'
    scenario = 'gallery-connectivity-smoke'
    captured_at = $now.ToUniversalTime().ToString('o')
    screenshots_dir = 'screenshots/web/unspecified'
    logs_dir = 'logs'
} | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $runRoot 'manifest.json')

[ordered]@{
    date = $date
    run_id = $runId
    target = "../$date/$runId"
} | ConvertTo-Json -Depth 3 | Set-Content -Encoding utf8 (Join-Path $todayRoot 'manifest.json')

[pscustomobject]@{
    ok = $true
    image = $imagePath
    gallery_path = "/$component/today"
