$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root
$fixtureCache = Join-Path $root 'ops/ubuntu/deployment/__pycache__'
try {
    & npm run test:release-transaction
    if ($LASTEXITCODE -ne 0) { throw "Release transaction fixture checks failed: $LASTEXITCODE" }
    & npm run test:deployment-preflight
    if ($LASTEXITCODE -ne 0) { throw "Deployment preflight fixture checks failed: $LASTEXITCODE" }
    & /usr/bin/python3 -I ops/ubuntu/deployment/root-authenticated-smoke-regression.py
    if ($LASTEXITCODE -ne 0) { throw "Protected authenticated MCP smoke fixture failed: $LASTEXITCODE" }
    Write-Output 'BROWSER_RELEASE_TRANSACTION_FIXTURES_GREEN'
} finally {
    # Python may create untracked bytecode beneath the isolated source fixture.
    # Only clean this known generated cache; never mutate the release store.
    if (Test-Path -LiteralPath $fixtureCache -PathType Container) {
        $item = Get-Item -LiteralPath $fixtureCache -Force
        if ($item.LinkType) { throw 'Refuse to clean symlinked fixture cache' }
        Remove-Item -LiteralPath $fixtureCache -Recurse -Force
    }
}
