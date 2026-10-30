$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/23-browser-relaunch.ps1')

# Model desktop and browser evidence independently; never launch or stop a browser.
$script:testSession = 7
$script:testBrowser = $false
$script:testVisible = $false
$script:testConsole = $true
function Get-BrowserStackHealthReport {
    [pscustomobject]@{
        microsoft_edge = [pscustomobject]@{ visible_window_detected = $script:testVisible }
        cdp_9223 = [pscustomobject]@{ ok = $script:testBrowser }
        target_inventory = [pscustomobject]@{ chatgpt_target_count = [int]$script:testBrowser }
    }
}
function Get-ConsoleSessionReport {
    [pscustomobject]@{ ok = $script:testConsole; active_console = [pscustomobject]@{ id = 7 } }
}
function Get-Process { param($Id) [pscustomobject]@{ SessionId = $script:testSession } }
function Get-CimInstance {
    param($ClassName, $Filter)
    if ($Filter -eq "Name='explorer.exe'" -or $script:testBrowser) {
        [pscustomobject]@{ SessionId = 7 }
    }
}
function Assert-Lease($Actual, [bool]$Expected, [string]$Case) {
    if ($Actual.ok -ne $Expected) { throw "Lease mismatch: $Case" }
}
Assert-Lease (Get-InteractiveDesktopCapabilityLease) $true 'eligible desktop without browser permits recovery'
Assert-Lease (Get-InteractiveDesktopCapabilityLease -RequireBrowserReady) $false 'explicit browser requirement'
Assert-Lease (Get-InteractiveDesktopCapabilityLease -RequireVisibleWindow) $false 'explicit visibility requirement'
$script:testSession = 0
Assert-Lease (Get-InteractiveDesktopCapabilityLease) $false 'wrong session remains blocked'
$script:testSession = 7
$script:testConsole = $false
Assert-Lease (Get-InteractiveDesktopCapabilityLease) $false 'ineligible console remains blocked'
$script:testConsole = $true
$script:testBrowser = $true
$script:testVisible = $true
Assert-Lease (Get-InteractiveDesktopCapabilityLease -RequireBrowserReady -RequireVisibleWindow) $true 'complete evidence'
Write-Output 'DESKTOP_CAPABILITY_LEASE_REGRESSION_PASS (6 cases)'
