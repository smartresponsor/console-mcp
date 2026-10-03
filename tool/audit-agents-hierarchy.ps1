param(
    [string]$WorkspaceRoot = 'D:\PhpstormProjects\www'
)

$ErrorActionPreference = 'Stop'
$skipSegments = @('.git','vendor','node_modules','var','cache','coverage','dist','build','.venv','venv')
$artifactSegments = @('.gating','.console-mcp','.commanding','.codex-tmp','backup','backups','artifacts','artifact')

$files = Get-ChildItem -LiteralPath $WorkspaceRoot -Filter 'AGENTS.md' -File -Recurse -Force -ErrorAction SilentlyContinue | Where-Object {
    $segments = $_.FullName.Substring($WorkspaceRoot.Length).TrimStart('\').Split('\')
    -not ($segments | Where-Object { $skipSegments -contains $_ })
}

$rows = foreach ($file in $files) {
    $relative = $file.FullName.Substring($WorkspaceRoot.Length).TrimStart('\')
    $segments = $relative.Split('\')
    $artifact = [bool]($segments | Where-Object { $artifactSegments -contains $_ })
    $content = Get-Content -LiteralPath $file.FullName -Raw
    [pscustomobject]@{
        path = $file.FullName
        relative = $relative
        artifact = $artifact
        stale_zero_crud = $content.Contains('zero CRUD controllers')
        generic_crud_qualified = $content.Contains('zero generic application CRUD controllers outside Cruding')
        canon_precedence = $content.Contains('Canonization textual rules are authoritative') -or $content.Contains('authoritative textual rule in Canonization') -or $content.Contains('must not override or contradict Canonization')
        easyadmin_exception = $content.Contains('EasyAdmin CRUD controllers') -or $content.Contains('EasyAdmin CRUD explicitly exempt')
        bytes = $file.Length
    }
}

$rows | Sort-Object relative | ConvertTo-Json -Depth 3
