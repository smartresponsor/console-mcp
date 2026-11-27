$ErrorActionPreference = 'Stop'
$repo = '/home/alex/smartresponse/mcp/console-mcp'
$production = '473144da9d50dcce16590fa81b50b411d6ac3dc2'
$candidate = '9e216178dd5a76b55bd1f9fd607f956041923ab3'
foreach ($sha in @($production,$candidate)) {
  & git -C $repo cat-file -t $sha
  if ($LASTEXITCODE -ne 0) { throw "BASELINE_UNAVAILABLE $sha" }
}
Write-Output 'PRODUCTION_ONLY / CANDIDATE_ONLY'
& git -C $repo rev-list --left-right --count "$production...$candidate"
if ($LASTEXITCODE -ne 0) { throw 'BASELINE_COMPARISON_FAILED' }
Write-Output 'MERGE_BASE'
& git -C $repo merge-base $production $candidate
if ($LASTEXITCODE -ne 0) { throw 'MERGE_BASE_UNAVAILABLE' }
Write-Output 'BASELINE_TREE_CHANGE_SUMMARY'
& git -C $repo diff --shortstat $production $candidate
if ($LASTEXITCODE -ne 0) { throw 'BASELINE_DIFF_FAILED' }
