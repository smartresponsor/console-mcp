$ErrorActionPreference='Stop'
$out=[ordered]@{user=[Environment]::UserName;uid=$null;home=$HOME;binaries=@{};roots=@{};podman=$null;namespace=$null;existing=@();warnings=@()}
try{$out.uid=(& id -u)}catch{}
foreach($name in @('initdb','pg_ctl','postgres','pg_isready','psql','podman','unshare')){try{$c=Get-Command $name -ErrorAction SilentlyContinue;$out.binaries[$name]=if($c){$c.Source}else{$null}}catch{$out.binaries[$name]=$null}}
foreach($dir in @('/usr/lib/postgresql/16/bin','/usr/lib/postgresql/15/bin','/var/lib/console-mcp','/home/alex/smartresponse/mcp/console-mcp/var','/tmp')){
 $item=[ordered]@{exists=(Test-Path -LiteralPath $dir);writable=$false;initdb=$false;pg_ctl=$false}
 if($item.exists){try{$item.owner=(& stat -c '%A %U:%G' $dir 2>$null)}catch{};try{& test -w $dir;$item.writable=($LASTEXITCODE -eq 0)}catch{}}
 $item.initdb=Test-Path -LiteralPath (Join-Path $dir 'initdb');$item.pg_ctl=Test-Path -LiteralPath (Join-Path $dir 'pg_ctl');$out.roots[$dir]=$item
}
try{$out.existing=@(& pg_lsclusters --no-header 2>$null|ForEach-Object{[string]$_})}catch{}
try{$out.podman=@(& podman info --format '{{.Host.Security.Rootless}}' 2>&1|ForEach-Object{[string]$_});$out.podmanExit=$LASTEXITCODE}catch{$out.warnings+=$_.Exception.Message}
try{$out.namespace=@(& unshare -Ur true 2>&1|ForEach-Object{[string]$_});$out.namespaceExit=$LASTEXITCODE}catch{$out.warnings+=$_.Exception.Message}
$out|ConvertTo-Json -Depth 8
