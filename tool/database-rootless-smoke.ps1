$ErrorActionPreference='Stop'
$bin='/usr/lib/postgresql/16/bin'
$base=Join-Path $HOME 'db-sandbox-smoke'
$nonce=[guid]::NewGuid().ToString('N')
$folder=Join-Path $base $nonce
$data=Join-Path $folder 'data'
$sock=Join-Path $folder 'socket'
$log=Join-Path $folder 'postgres.log'
$started=$false
$report=[ordered]@{ok=$false;user=[Environment]::UserName;version=$null;db=$null;tables=$null;cleaned=$false;error=$null}
try {
 [IO.Directory]::CreateDirectory($folder)|Out-Null
 & chmod 700 $folder
 [IO.Directory]::CreateDirectory($sock)|Out-Null
 & chmod 700 $sock
 & (Join-Path $bin 'initdb') -D $data -A trust --no-instructions --encoding=UTF8 --locale=C 2>&1 | Out-Null
 if($LASTEXITCODE -ne 0){throw 'initdb failed'}
 & (Join-Path $bin 'pg_ctl') -D $data -l $log -o "-c listen_addresses= -c unix_socket_directories=$sock -c port=55432 -c max_connections=15" -w start 2>&1 | Out-Null
 if($LASTEXITCODE -ne 0){throw 'pg_ctl start failed'}
 $started=$true
 $report.version=(& (Join-Path $bin 'psql') -h $sock -p 55432 -U console-mcp -d postgres -X -A -t -v ON_ERROR_STOP=1 -c 'select current_setting(''server_version'')')
 & (Join-Path $bin 'createdb') -h $sock -p 55432 -U console-mcp cmcp_test_smoke
 if($LASTEXITCODE -ne 0){throw 'createdb failed'}
 $report.db=(& (Join-Path $bin 'psql') -h $sock -p 55432 -U console-mcp -d cmcp_test_smoke -X -A -t -v ON_ERROR_STOP=1 -c 'select current_database()')
 $report.tables=(& (Join-Path $bin 'psql') -h $sock -p 55432 -U console-mcp -d cmcp_test_smoke -X -A -t -v ON_ERROR_STOP=1 -c 'select count(*) from pg_catalog.pg_class')
 $report.ok=($report.db -eq 'cmcp_test_smoke')
} catch {$report.error=$_.Exception.Message}
finally {
 if($started){& (Join-Path $bin 'pg_ctl') -D $data -m immediate -w stop 2>&1 | Out-Null}
 if(Test-Path $folder){Remove-Item -LiteralPath $folder -Recurse -Force}
 $report.cleaned=!(Test-Path $folder)
}
$report|ConvertTo-Json -Depth 5
if(!$report.ok -or !$report.cleaned){exit 1}
