$ErrorActionPreference='Stop'
$project=Join-Path $PSScriptRoot '../ops/windows-sealer-service/ConsoleMcp.Sealer.Service.csproj'
$source=Join-Path $PSScriptRoot '../ops/windows-sealer-service/Program.cs'
if(-not (Test-Path -LiteralPath $project -PathType Leaf) -or -not (Test-Path -LiteralPath $source -PathType Leaf)){
 throw 'RELEASE_SEAL_SERVICE_SOURCES_MISSING'
}
$xml=[xml](Get-Content -LiteralPath $project -Raw)
if($xml.Project.PropertyGroup.OutputType -cne 'Exe' -or
   $xml.Project.PropertyGroup.TargetFramework -cne 'net8.0-windows' -or
   $xml.Project.PropertyGroup.AssemblyName -cne 'ConsoleMcp.Sealer.Service'){
 throw 'RELEASE_SEAL_SERVICE_PROJECT_INVALID'
}
$code=[IO.File]::ReadAllText($source)
foreach($required in @('StartServiceCtrlDispatcher','RegisterServiceCtrlHandlerEx','SetServiceStatus','S-1-5-18','SessionId != 0','StopEvent.Wait()')){
 if(-not $code.Contains($required)){throw ('RELEASE_SEAL_SERVICE_NATIVE_GATE_MISSING: '+$required)}
}
foreach($forbidden in @('NamedPipeServerStream','HttpListener','Process.Start(','SetAccessControl(','CreateServiceW(','RSA.ImportFromPem(')){
 if($code.Contains($forbidden)){throw ('RELEASE_SEAL_SERVICE_UNAPPROVED_CAPABILITY: '+$forbidden)}
}
'RELEASE_SEAL_SERVICE_SOURCE_REGRESSION_PASS'
