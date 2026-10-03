param(
    [string]$WorkspaceRoot = 'D:\PhpstormProjects\www'
)

$ErrorActionPreference = 'Stop'
$rows = @()

$rootAgent = Join-Path $WorkspaceRoot 'AGENTS.md'
if (Test-Path -LiteralPath $rootAgent -PathType Leaf) {
    $c = Get-Content -LiteralPath $rootAgent -Raw
    $rows += [pscustomobject]@{
        repository = '__workspace__'
        path = $rootAgent
        relative = 'AGENTS.md'
        stale_zero_crud = $c.Contains('zero CRUD controllers')
        generic_crud_qualified = $c.Contains('zero generic application CRUD controllers outside Cruding')
        canon_precedence = $c.Contains('Canonization textual rules are authoritative') -or $c.Contains('authoritative textual rule in Canonization') -or $c.Contains('must not override or contradict Canonization')
        easyadmin_exception = $c.Contains('EasyAdmin CRUD controllers') -or $c.Contains('EasyAdmin CRUD explicitly exempt')
    }
}

$repos = Get-ChildItem -LiteralPath $WorkspaceRoot -Directory | Where-Object {
    Test-Path -LiteralPath (Join-Path $_.FullName '.git')
}

foreach ($repo in $repos) {
    $paths = & git -C $repo.FullName ls-files '*AGENTS.md' 2>$null
    if ($LASTEXITCODE -ne 0) { continue }

    foreach ($relative in $paths) {
        $full = Join-Path $repo.FullName $relative
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
        $c = Get-Content -LiteralPath $full -Raw
        $rows += [pscustomobject]@{
            repository = $repo.Name
            path = $full
            relative = $relative
            stale_zero_crud = $c.Contains('zero CRUD controllers')
            generic_crud_qualified = $c.Contains('zero generic application CRUD controllers outside Cruding')
            canon_precedence = $c.Contains('Canonization textual rules are authoritative') -or $c.Contains('authoritative textual rule in Canonization') -or $c.Contains('must not override or contradict Canonization')
            easyadmin_exception = $c.Contains('EasyAdmin CRUD controllers') -or $c.Contains('EasyAdmin CRUD explicitly exempt')
        }
    }
}

$rows | Sort-Object repository, relative | ConvertTo-Json -Depth 3
