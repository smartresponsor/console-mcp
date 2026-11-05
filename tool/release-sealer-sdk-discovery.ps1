$ErrorActionPreference='Stop'
$hostName=[Environment]::MachineName
$commands=@('dotnet','msbuild','csc','winget')
$result=[ordered]@{status='RELEASE_SEAL_SDK_DISCOVERY';host=$hostName;platform=[Environment]::OSVersion.Platform.ToString();tools=@{};sdk_versions=@();build_available=$false;mutation_performed=$false}
foreach($name in $commands){
 $command=Get-Command $name -ErrorAction SilentlyContinue
 $result.tools[$name]=if($command){[string]$command.Source}else{''}
}
if($result.tools.dotnet){
 $versions=@(& $result.tools.dotnet --list-sdks 2>$null)
 if($LASTEXITCODE -eq 0){$result.sdk_versions=@($versions | Where-Object {$_})}
}
$result.build_available=@($result.sdk_versions).Count -gt 0
$result | ConvertTo-Json -Depth 6 -Compress
