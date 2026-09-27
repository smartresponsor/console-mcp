param(
    [Parameter(Mandatory = $true)][string]$TargetId,
    [Parameter(Mandatory = $true)][string]$ChatId
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    $target = $TargetId.Replace("'", "\'")
    $chat = $ChatId.Replace("'", "\'")
    $script = @"
import { closeChatGptConversationTarget } from "./dist/service/browser-session-executor.js";
const result = await closeChatGptConversationTarget({ ports: [9223], targetId: '$target', chatId: '$chat', timeoutMs: 10000 });
console.log(JSON.stringify({ ...result, conversation_deleted: false }));
if (result.ok !== true && result.already_closed !== true) process.exitCode = 1;
"@
    & node --input-type=module -e $script
    if ($LASTEXITCODE -ne 0) { throw "Target-only close failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}
