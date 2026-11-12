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
$listeners = @()
foreach ($port in @(3333,3334,8765)) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $task = $client.ConnectAsync('127.0.0.1',$port)
    $open = $task.Wait(400) -and $client.Connected
  } catch { $open = $false } finally { $client.Dispose() }
  $listeners += [pscustomobject]@{ port=$port; listening=$open }
}
$processes = @()
foreach ($entry in @(Get-ChildItem /proc -Directory -ErrorAction SilentlyContinue | Where-Object Name -Match '^[0-9]+$')) {
  try {
    $cmd = [System.IO.File]::ReadAllText((Join-Path $entry.FullName 'cmdline')).Replace([char]0,' ')
    if ($cmd -match 'oauth|callback|auth0|console-mcp') {
      $exe = [System.IO.Path]::GetFileName(([string]($cmd -split ' ')[0]))
      $processes += [pscustomobject]@{ pid=[int]$entry.Name; executable=$exe; matched=$true }
    }
  } catch {}
}
[pscustomobject]@{ source_matches=@($hits | Select-Object -First 100); listeners=$listeners; processes=@($processes | Select-Object -First 30) } | ConvertTo-Json -Depth 4
