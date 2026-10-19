[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$SourceWorktree,
  [Parameter(Mandatory=$true)][string]$ExpectedSha,
  [Parameter(Mandatory=$true)][string]$CandidatePath
)
$ErrorActionPreference = 'Stop'
if ($ExpectedSha -notmatch '^[0-9a-f]{40}$') { throw 'Invalid expected SHA' }
$source = (Resolve-Path -LiteralPath $SourceWorktree -ErrorAction Stop).Path
$control = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..') -ErrorAction Stop).Path
$candidate = [IO.Path]::GetFullPath($CandidatePath)
$parent = [IO.Path]::GetFullPath((Split-Path -Parent $control))
if (-not $candidate.StartsWith($parent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Candidate must be under MCP parent' }
if (Test-Path -LiteralPath $candidate) { throw 'Candidate path already exists' }
$head = (& git -C $source rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $head -ne $ExpectedSha) { throw 'Source SHA mismatch' }
$sourceCommon = (& git -C $source rev-parse --path-format=absolute --git-common-dir).Trim()
$controlCommon = (& git -C $control rev-parse --path-format=absolute --git-common-dir).Trim()
if ($sourceCommon -ine $controlCommon) { throw 'Source is not in control repository' }
& git -C $control worktree add --detach $candidate $ExpectedSha
if ($LASTEXITCODE -ne 0) { throw 'worktree creation failed' }
$resultHead = (& git -C $candidate rev-parse HEAD).Trim()
$status = (& git -C $candidate status --porcelain)
if ($LASTEXITCODE -ne 0 -or $resultHead -ne $ExpectedSha -or $status) { throw 'Created worktree did not validate as clean' }
@{ok=$true;status='ISOLATED_CANDIDATE_CREATED';candidate=$candidate;head=$resultHead;clean=$true} | ConvertTo-Json -Compress
