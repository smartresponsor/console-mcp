param(
    [ValidateSet('Inspect','Apply')]
    [string]$Mode = 'Inspect',
    [string]$WorkspaceRoot = 'D:\PhpstormProjects\www'
)

$ErrorActionPreference = 'Stop'
$precedenceBlock = @'

## Platform Canon Precedence

For work under `D:\PhpstormProjects\www`, authoritative platform rules live in the Canonization repository. Gating is the executable mirror for objectively guardable rules. This `AGENTS.md` is an agent-facing projection or local supplement and must not override or contradict Canonization.

If a local instruction conflicts with current Canonization, follow Canonization and synchronize this file. Local instructions may narrow scope or add repository-specific constraints only when they remain compatible with Canonization.
'@

$oldHeading = '## 5. Zero CRUD controllers и zero CRUD routes YAML'
$newHeading = '## 5. Generic application CRUD ownership и EasyAdmin exception'
$oldState = @'
Целевое состояние обычного приложения:

```text
zero CRUD controllers
zero CRUD routes YAML
```
'@
$newState = @'
Целевое состояние обычного приложения относится к generic application CRUD, которым владеет Cruding:

```text
zero generic application CRUD controllers outside Cruding
zero generic application CRUD routes YAML outside Cruding
```

EasyAdmin CRUD controllers and routes used for administrative/back-office surfaces are explicitly allowed by Canon021. They are an admin UI surface and do not compete with Cruding's generic application CRUD ownership.

`Generated` in an EasyAdmin controller name or path does not by itself make that controller a disposable generated artifact. Do not delete or untrack an EasyAdmin CRUD controller merely because it is named `Generated`, `Crud`, or `CrudController`. Removal requires a separate explicit canonical rule plus runtime/admin-behavior evidence that the source is reproducible and behaviorally replaced.
'@

$targets = @()
$rootAgent = Join-Path $WorkspaceRoot 'AGENTS.md'
if (Test-Path -LiteralPath $rootAgent -PathType Leaf) { $targets += $rootAgent }

$repos = Get-ChildItem -LiteralPath $WorkspaceRoot -Directory | Where-Object {
    Test-Path -LiteralPath (Join-Path $_.FullName '.git')
}
foreach ($repo in $repos) {
    $tracked = & git -C $repo.FullName ls-files '*AGENTS.md' 2>$null
    if ($LASTEXITCODE -ne 0) { continue }
    foreach ($relative in $tracked) {
        $full = Join-Path $repo.FullName $relative
        if (Test-Path -LiteralPath $full -PathType Leaf) { $targets += $full }
    }
}

foreach ($target in ($targets | Sort-Object -Unique)) {
    $content = Get-Content -LiteralPath $target -Raw
    $beforeHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    $updated = $content
    $hadStaleCrud = $updated.Contains('zero CRUD controllers')
    if ($updated.Contains($oldHeading)) { $updated = $updated.Replace($oldHeading, $newHeading) }
    if ($updated.Contains($oldState)) { $updated = $updated.Replace($oldState, $newState) }
    $hasPrecedence = $updated.Contains('Canonization textual rules are authoritative') -or
        $updated.Contains('authoritative textual rule in Canonization') -or
        $updated.Contains('## Platform Canon Precedence') -or
        $updated.Contains('must not override or contradict Canonization')
    if (-not $hasPrecedence) {
        $updated = $updated.TrimEnd() + $precedenceBlock + [Environment]::NewLine
    }
    $changed = $updated -ne $content
    if ($Mode -eq 'Apply' -and $changed) {
        Set-Content -LiteralPath $target -Value $updated -Encoding utf8NoBOM -NoNewline
    }
    [pscustomobject]@{
        path = $target
        stale_crud_before = $hadStaleCrud
        precedence_before = $hasPrecedence
        changed = $changed
        mode = $Mode
        before_sha256 = $beforeHash
        after_sha256 = if ($Mode -eq 'Apply' -and $changed) { (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() } else { $beforeHash }
    } | ConvertTo-Json -Compress
}
