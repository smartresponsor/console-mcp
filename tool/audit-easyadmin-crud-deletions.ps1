param(
    [string]$WorkspaceRoot = 'D:\PhpstormProjects\www'
)

$ErrorActionPreference = 'Stop'

$repos = Get-ChildItem -LiteralPath $WorkspaceRoot -Directory | Where-Object {
    Test-Path -LiteralPath (Join-Path $_.FullName '.git')
}

$results = foreach ($repo in $repos) {
    $composerPath = Join-Path $repo.FullName 'composer.json'
    $hasEasyAdmin = $false
    if (Test-Path -LiteralPath $composerPath -PathType Leaf) {
        try {
            $composer = Get-Content -LiteralPath $composerPath -Raw | ConvertFrom-Json
            $requires = @{}
            if ($composer.require) {
                $composer.require.psobject.Properties | ForEach-Object { $requires[$_.Name] = $_.Value }
            }
            if ($composer.'require-dev') {
                $composer.'require-dev'.psobject.Properties | ForEach-Object { $requires[$_.Name] = $_.Value }
            }
            $hasEasyAdmin = $requires.ContainsKey('easycorp/easyadmin-bundle')
        } catch {}
    }

    $log = & git -C $repo.FullName log --all --diff-filter=D --name-status --format='@@@%H|%aI|%s' -- '*.php' 2>$null
    if ($LASTEXITCODE -ne 0) { continue }

    $commit = $null
    foreach ($line in $log) {
        if ($line -like '@@@*') {
            $parts = $line.Substring(3).Split('|', 3)
            $commit = [pscustomobject]@{
                hash = $parts[0]
                date = $parts[1]
                subject = $parts[2]
            }
            continue
        }
        if (-not $commit -or $line -notmatch '^D\s+(.+)$') { continue }
        $path = $Matches[1]
        if ($path -notmatch '(?i)(CrudController\.php$|Controller[/\\]Crud[/\\]Generated[/\\].+\.php$)') { continue }

        [pscustomobject]@{
            repository = $repo.Name
            easyadmin_dependency = $hasEasyAdmin
            commit = $commit.hash
            date = $commit.date
            subject = $commit.subject
            deleted_path = $path
            generated_path = $path -match '(?i)Controller[/\\]Crud[/\\]Generated[/\\]'
        }
    }
}

$results |
    Sort-Object repository, date, deleted_path |
    ConvertTo-Json -Depth 4
