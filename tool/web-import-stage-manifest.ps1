$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$stage=Join-Path $root 'tmp/visible-runtime-import-20261016'
$dist=Join-Path $stage 'dist'
if(-not (Test-Path (Join-Path $dist 'index.js'))){throw 'Validated dist missing'}
$manifest=Join-Path $stage 'import-dist.sha256'
$files=Get-ChildItem -LiteralPath $dist -File -Recurse | Sort-Object FullName
$rows=foreach($file in $files){$hash=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant(); $relative=[IO.Path]::GetRelativePath($stage,$file.FullName); $hash+'  '+$relative}
[IO.File]::WriteAllLines($manifest,[string[]]$rows)
Write-Output ('HASHED_FILES='+$files.Count)
Write-Output ('HAS_IMPORT='+[bool](Test-Path (Join-Path $dist 'tool/web-artifact-import.js')))
