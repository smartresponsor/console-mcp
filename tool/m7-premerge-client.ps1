param(
 [Parameter(Mandatory=$true)][ValidateSet('accept','status')][string]$Action,
 [string]$Sha,
 [string]$RunId,
 [switch]$Confirm
)
$ErrorActionPreference='Stop'
if (-not $IsLinux) { throw 'RELEASE_PREMERGE_LINUX_ONLY' }
$args2=@($Action)
if ($Action -eq 'accept') {
 if ($Sha -cnotmatch '^[0-9a-f]{40}$' -or -not $Confirm -or $RunId) { throw 'RELEASE_PREMERGE_EXACT_SHA_AND_CONFIRM_REQUIRED' }
 $args2+=@('--sha',$Sha,'--confirm')
} else {
 if ($RunId -cnotmatch '^[0-9a-f]{32}$' -or $Sha -or $Confirm) { throw 'RELEASE_PREMERGE_RUN_ID_REQUIRED' }
 $args2+=@('--run-id',$RunId)
}
& /usr/bin/python3 -I -B (Join-Path $PSScriptRoot 'm7-premerge-client.py') @args2
exit $LASTEXITCODE
