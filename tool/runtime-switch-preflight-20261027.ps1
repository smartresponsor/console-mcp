$ErrorActionPreference = 'Stop'
$root = (Get-Location).Path
$dist = Join-Path $root 'dist'
$entry = Join-Path $dist 'index.js'
$status = & git status --porcelain
$head = (& git rev-parse HEAD).Trim()
$origin = (& git rev-parse origin/master).Trim()
$runtime = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { [string]$_.CommandLine -like "*$entry*" })
$watchdog = @(Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'" | Where-Object { [string]$_.CommandLine -match 'watchdog-loop-run|watchdog-task-bootstrap' })
$files = @(Get-ChildItem -LiteralPath $dist -Recurse -File -Filter '*.js' -ErrorAction SilentlyContinue)
$hashes = @($files | ForEach-Object { [pscustomobject]@{path=$_.FullName.Substring($dist.Length+1).Replace('\','/');sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()} })
$session = @(query session 2>$null) -join "`n"
$blocks = @()
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {$blocks += 'dist_entry_missing'}
if ($runtime.Count -ne 1) {$blocks += 'runtime_identity_not_unique'}
if ($watchdog.Count -ne 1) {$blocks += 'watchdog_identity_not_unique'}
if ($files.Count -eq 0) {$blocks += 'no_dist_js_files'}
if ($status.Count -gt 0) {$blocks += 'working_tree_dirty'}
$result = [ordered]@{schema_version=1;status='READ_ONLY_PREFLIGHT';ready=($blocks.Count -eq 0);blocks=$blocks;at=(Get-Date).ToString('o');head=$head;origin_master=$origin;runtime_pid=if($runtime.Count -eq 1){[int]$runtime[0].ProcessId}else{$null};runtime_count=$runtime.Count;watchdog_count=$watchdog.Count;dist_entry=$entry;file_count=$hashes.Count;manifest=$hashes;session=$session}
$result | ConvertTo-Json -Depth 8
