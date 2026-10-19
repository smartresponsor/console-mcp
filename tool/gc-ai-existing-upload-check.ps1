$ErrorActionPreference='Stop'
$path='/home/alex/smartresponse/var/artifacts/uploads'
$exists=Test-Path -LiteralPath $path -PathType Container
Write-Output ('UPLOAD_ROOT_EXISTS='+$exists)
if($exists){$item=Get-Item -LiteralPath $path; Write-Output ('UPLOAD_ROOT_PATH='+$item.FullName); Write-Output ('UNIX_MODE='+$item.UnixMode); Write-Output ('OWNER='+$item.User); Write-Output ('GROUP='+$item.Group)}
Write-Output ('EUID='+([System.Environment]::UserName))
