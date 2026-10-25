# Prepare a verified, isolated Console MCP release candidate. Does not touch the live runtime.
[CmdletBinding()]
param(
  [string]$Ref = 'origin/master',
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$ExpectedCommit
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$sha = (& git -C $root rev-parse --verify "$Ref^{commit}" | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $sha -ine $ExpectedCommit) { throw "Ref mismatch: actual=$sha expected=$ExpectedCommit" }
$parent = Split-Path -Parent $root
$candidate = Join-Path $parent ("console-mcp-release-" + $sha.Substring(0,12))
if (Test-Path -LiteralPath $candidate) { throw "Candidate already exists; refusing to modify: $candidate" }
$modules = Join-Path $root 'node_modules'
if (-not (Test-Path -LiteralPath $modules -PathType Container)) { throw 'Existing node_modules unavailable' }
$added = $false
try {
  & git -C $root worktree add --detach $candidate $sha
  if ($LASTEXITCODE -ne 0) { throw 'Worktree creation failed' }
  $added = $true
  New-Item -ItemType Junction -Path (Join-Path $candidate 'node_modules') -Target $modules -ErrorAction Stop | Out-Null
  & npm --prefix $candidate run build
  if ($LASTEXITCODE -ne 0) { throw 'Release build failed' }
  & npm --prefix $candidate test
  if ($LASTEXITCODE -ne 0) { throw 'Release tests failed' }
  # Confirm that tests did not modify tracked candidate files.
  $dirty = (& git -C $candidate status --porcelain | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $dirty) { throw "Candidate worktree dirty after tests: $dirty" }
  $preflight = Join-Path $candidate 'tool/runtime-deployment-preflight.ps1'
  & $preflight -WorkspacePath $root -CandidatePath $candidate -ExpectedCommit $sha
  if ($LASTEXITCODE -ne 0) { throw 'Release preflight failed' }
  Write-Output ('RELEASE_CANDIDATE_READY ' + $candidate + ' ' + $sha)
} catch {
  if ($added) {
    $junction = Join-Path $candidate 'node_modules'
    if (Test-Path -LiteralPath $junction) { [System.IO.Directory]::Delete($junction) }
    & git -C $root worktree remove --force $candidate
  }
  throw
}
