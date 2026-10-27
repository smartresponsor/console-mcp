# Read-only bounded application-level health probe for isolated HTTP fixtures.
# HTTP success must be combined with independent process identity observation.
function Test-RuntimeReleaseIsolatedHttpHealth {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][uri]$Uri,
        [ValidateRange(100,30000)][int]$TimeoutMs = 2000
    )
    if ($Uri.Scheme -cne 'http' -or $Uri.Host -notin @('127.0.0.1','localhost','::1')) {
        return $false
    }
    try {
        $response = Invoke-WebRequest -Uri $Uri -Method Get -TimeoutSec ([math]::Max(1,[math]::Ceiling($TimeoutMs / 1000))) -UseBasicParsing -ErrorAction Stop
        return ([int]$response.StatusCode -eq 200)
    } catch {
        return $false
    }
}
