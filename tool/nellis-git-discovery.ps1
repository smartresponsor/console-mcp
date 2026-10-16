$ErrorActionPreference='Stop'
$roots=@('/home/alex/smartresponse','/home/alex/smartresponse/mcp','/home/alex/smartresponse/mcp/looping','/home/alex/smartresponse/mcp/looping/browsing','/home/alex/smartresponse/mcp/console-mcp')
$rows=foreach($root in $roots){if(Test-Path $root){Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '(?i)nellis|auction|consumer' } | ForEach-Object {[pscustomobject]@{path=$_.FullName;git=(Test-Path (Join-Path $_.FullName '.git'));itemCount=@(Get-ChildItem -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue).Count}}}}
$owners=@('/home/alex/smartresponse/mcp/looping/browsing','/home/alex/smartresponse/mcp/console-mcp') | ForEach-Object { $x=Get-Item -LiteralPath $_; [pscustomobject]@{path=$_.ToString();owner=( & /usr/bin/stat -c '%U:%G' $_)}}
[pscustomobject]@{directories=@($rows);owners=@($owners)} | ConvertTo-Json -Depth 5 -Compress
