[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$entry = Join-Path $root 'src/index.ts'
$tool = Join-Path $root 'src/tool/web-artifact-import.ts'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf) -or -not (Test-Path -LiteralPath $tool -PathType Leaf)) {
  throw 'WEB_ARTIFACT_IMPORT_MISSING: canonical files are required.'
}
$source = Get-Content -LiteralPath $entry -Raw
$imported = $source.Contains('import { registerWebArtifactImportTool } from "./tool/web-artifact-import.js";')
$registered = $source.Contains('registerWebArtifactImportTool(mcpServer, authConfig);')
$branch = (& git -C $root branch --show-current | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect canonical Git branch.' }
$ok = $imported -and $registered -and $branch -eq 'master'
[pscustomobject]@{
  ok = $ok
  status = if ($ok) { 'WEB_ARTIFACT_IMPORT_ALREADY_CANONICAL' } else { 'WEB_ARTIFACT_IMPORT_CANONICAL_CHECK_FAILED' }
  branch = $branch
  imported = $imported
  registered = $registered
  created_worktree = $false
  mutation_attempted = $false
  next_action = if ($ok) { 'none; use canonical master, do not create a staging worktree' } else { 'review canonical web artifact import before proceeding' }
} | ConvertTo-Json -Depth 3
if (-not $ok) { exit 2 }
