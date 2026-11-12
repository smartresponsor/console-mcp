param()
$ErrorActionPreference = 'Stop'
$roots = @('/home/alex/smartresponse/mcp','/home/alex/smartresponse/console-mcp-dev','/home/alex/smartresponse/browsing-security-runtime-ops')
$patterns = @('8765','code_verifier','redirect_uri','/authorize')
$hits = New-Object System.Collections.Generic.List[object]
foreach ($root in $roots) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  $files = Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '/(node_modules|\.git|var|dist|vendor|\.worktrees|\.releases)/' -and $_.Extension -in @('.ts','.js','.mjs','.ps1','.json','.sh','.md') } | Select-Object -First 3000
  foreach ($f in $files) {
    try {
      $match = Select-String -LiteralPath $f.FullName -Pattern $patterns -List -ErrorAction Stop
      if ($match) { $hits.Add([pscustomobject]@{ file=$f.FullName; pattern=$match.Pattern }) }
    } catch {}
  }
}
$hits | Select-Object -First 100 | ConvertTo-Json -Depth 3
