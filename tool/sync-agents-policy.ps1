param(
    [ValidateSet('Inspect','Apply')]
    [string]$Mode = 'Inspect'
)

$ErrorActionPreference = 'Stop'

$workspaceRoot = 'D:\PhpstormProjects\www'
$targets = @(
    (Join-Path $workspaceRoot 'AGENTS.md'),
    (Join-Path $env:USERPROFILE '.codex\AGENTS.md')
)

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

Canonization textual rules are authoritative. If an `AGENTS.md` projection disagrees with them, the Canonization rule wins and the projection must be synchronized.
'@

$systemPrecedenceBlock = @'

## Platform Canon Precedence

When working anywhere under `D:\PhpstormProjects\www`, authoritative platform rules live in the Canonization repository. Gating is the executable mirror for objectively guardable rules. Workspace and repository `AGENTS.md` files are agent-facing projections and local supplements only; they must not override or contradict Canonization.

If an `AGENTS.md` instruction conflicts with current Canonization, follow Canonization and synchronize the stale projection before using it as implementation guidance. Repository-local instructions may narrow scope or add local constraints only when they remain compatible with Canonization.
'@

foreach ($target in $targets) {
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
        [pscustomobject]@{
            path = $target
            exists = $false
            mode = $Mode
        } | ConvertTo-Json -Compress
        continue
    }

    $content = Get-Content -LiteralPath $target -Raw
    $beforeHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    $hasOldHeading = $content.Contains($oldHeading)
    $hasOldState = $content.Contains($oldState)
    $hasPrecedence = $content.Contains('Canonization textual rules are authoritative') -or $content.Contains('authoritative textual rule in Canonization') -or $content.Contains('## Platform Canon Precedence') -or $content.Contains('must not override or contradict Canonization')
    $hasEasyAdminException = $content.Contains('EasyAdmin CRUD controllers') -or $content.Contains('EasyAdmin CRUD explicitly exempt')

    $updated = $content
    if ($hasOldHeading) {
        $updated = $updated.Replace($oldHeading, $newHeading)
    }
    if ($hasOldState) {
        $updated = $updated.Replace($oldState, $newState)
    }
    $userAgentPath = Join-Path $env:USERPROFILE '.codex\AGENTS.md'
    if ($target -eq $userAgentPath -and -not $hasPrecedence) {
        $updated = $updated.TrimEnd() + $systemPrecedenceBlock + [Environment]::NewLine
    }

    $changed = $updated -ne $content
    if ($Mode -eq 'Apply' -and $changed) {
        Set-Content -LiteralPath $target -Value $updated -Encoding utf8NoBOM -NoNewline
    }

    $afterHash = if ($Mode -eq 'Apply' -and $changed) {
        (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    } else {
        $beforeHash
    }

    [pscustomobject]@{
        path = $target
        exists = $true
        mode = $Mode
        outline = @($content -split "\r?\n" | Where-Object { $_ -match '^#{1,3}\s' } | Select-Object -First 40)
        relevant_lines = @($content -split "\r?\n" | Where-Object { $_ -match '(?i)canon|agent|crud|workspace|www|codex' } | Select-Object -First 80)
        old_heading = $hasOldHeading
        old_state = $hasOldState
        precedence_present = $hasPrecedence
        easyadmin_exception_present = $hasEasyAdminException
        changed = $changed
        before_sha256 = $beforeHash
        after_sha256 = $afterHash
    } | ConvertTo-Json -Compress
}
