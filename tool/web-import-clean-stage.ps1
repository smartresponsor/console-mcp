$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$stage=Join-Path $root 'tmp/visible-runtime-import-20261016'
if(Test-Path $stage){throw 'Staging directory already exists: refusing overwrite'}
& git -C $root worktree add --detach $stage HEAD
if($LASTEXITCODE -ne 0){throw 'Git worktree stage failed'}
$index=Join-Path $stage 'src/index.ts'
$body=[System.IO.File]::ReadAllText($index)
$body=$body.Replace('import { registerWebDomainBridgeTools } from "./tool/web-domain-bridge.js";','import { registerWebDomainBridgeTools } from "./tool/web-domain-bridge.js";' + [Environment]::NewLine + 'import { registerWebArtifactImportTool } from "./tool/web-artifact-import.js";')
$body=$body.Replace('  registerWebDomainBridgeTools(mcpServer, authConfig);','  registerWebDomainBridgeTools(mcpServer, authConfig);' + [Environment]::NewLine + '  registerWebArtifactImportTool(mcpServer, authConfig);')
[System.IO.File]::WriteAllText($index,$body)
Write-Output ('STAGED='+$stage)
