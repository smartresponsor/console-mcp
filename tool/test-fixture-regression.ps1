$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'test-fixture.ps1')
$fixture=New-ConsoleTestFixture -Prefix 'fixture-contract'
$sentinel=Join-Path $fixture 'unique.txt'
[IO.File]::WriteAllText($sentinel,'preserve')
try {
    foreach($target in @([IO.Path]::GetTempPath(),(Join-Path $fixture '..'),$sentinel)){
        $refused=$false
        try {Remove-ConsoleTestFixture $target} catch {$refused=$_.Exception.Message -eq 'FIXTURE_NOT_OWNED'}
        if(-not $refused -or -not (Test-Path -LiteralPath $sentinel)){throw 'Unowned cleanup was not refused'}
    }
    $marker=Join-Path $fixture '.console-test-owner';$original=[IO.File]::ReadAllText($marker)
    [IO.File]::WriteAllText($marker,'wrong-owner')
    try {Remove-ConsoleTestFixture $fixture;throw 'Tampered marker accepted'}catch{if($_.Exception.Message -ne 'FIXTURE_OWNER_CHANGED'){throw}}
    [IO.File]::WriteAllText($marker,$original)
    $readonly=Get-Item -LiteralPath $sentinel;$readonly.Attributes=$readonly.Attributes -bor [IO.FileAttributes]::ReadOnly
    Remove-ConsoleTestFixture $fixture
    if(Test-Path -LiteralPath $fixture){throw 'Owned cleanup failed'}
    @{ok=$true;status='OWNED_FIXTURE_CONTRACT_PASSED';unownedPathsPreserved=$true} | ConvertTo-Json
} finally {if(Test-Path -LiteralPath $fixture){Write-Output ('Fixture preserved after failure: '+$fixture)}}
