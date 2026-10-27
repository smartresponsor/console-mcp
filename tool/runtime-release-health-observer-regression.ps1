$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-health-observer.ps1')
if (Test-RuntimeReleaseIsolatedHttpHealth -Uri 'https://example.com/') { throw 'External health endpoint accepted.' }
if (Test-RuntimeReleaseIsolatedHttpHealth -Uri 'http://192.0.2.1:1234/') { throw 'Non-loopback health endpoint accepted.' }
if (Test-RuntimeReleaseIsolatedHttpHealth -Uri 'http://127.0.0.1:1/' -TimeoutMs 1000) { throw 'Unreachable health endpoint accepted.' }
'RUNTIME_RELEASE_HEALTH_OBSERVER_REGRESSION_PASS'
