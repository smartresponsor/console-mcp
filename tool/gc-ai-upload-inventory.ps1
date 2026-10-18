$ErrorActionPreference='Stop'
$roots=@('/var/lib/console-mcp-visible/upload','/var/lib/console-mcp-visible/artifact','/var/lib/console-mcp-browser/upload','/var/lib/console-mcp-browser/artifact')
foreach($r in $roots){if(Test-Path -LiteralPath $r){Get-ChildItem -LiteralPath $r -Recurse -File -ErrorAction SilentlyContinue | Where-Object {$_.Extension -eq '.pdf'} | Select-Object -First 25 @{n='root';e={$r}},Name,Length,FullName | ConvertTo-Json -Compress}}
