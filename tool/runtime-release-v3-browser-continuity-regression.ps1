# Pure boundary fixture: never enumerate real listeners or contact a browser.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'dev-console.d/89-release-v3-runtime.ps1')
$script:browserInstance='ws://127.0.0.1:9223/devtools/browser/instance-one'
$script:workerPid=200
$script:targets=@(@{id='stable-page';type='page'},@{id='frame-one';type='iframe'},@{id='js-one';type='worker'})
function Get-ListeningProcessOnPort([int]$Port){
 if($Port -eq 9223){return @{OwningProcess=100}}
 if($Port -eq 8791){return @{OwningProcess=$script:workerPid}}
 return $null
}
function Get-ReleaseV3ProcessIdentity($ProcessId){return @{pid=$ProcessId;started='stable-start';session=7}}
function Invoke-RestMethod([string]$Uri,[int]$TimeoutSec){
 if($Uri -eq 'http://127.0.0.1:9223/json/version'){return @{webSocketDebuggerUrl=$script:browserInstance}}
 if($Uri -eq 'http://127.0.0.1:9223/json/list'){return $script:targets}
 throw 'Unexpected network destination in inert browser fixture'
}
function Snapshot {Get-ReleaseV3BrowserSnapshot | ConvertTo-Json -Depth 30 -Compress}
$baseline=Snapshot
$script:targets=@(@{id='stable-page';type='page'},@{id='frame-two';type='iframe'},@{id='js-two';type='worker'})
if((Snapshot) -cne $baseline){throw 'Ephemeral child churn was mistaken for session loss'}
$script:targets=@(@{id='replacement-page';type='page'})
if((Snapshot) -ceq $baseline){throw 'Replacement page was accepted'}
$script:targets=@(@{id='stable-page';type='page'})
$script:browserInstance='ws://127.0.0.1:9223/devtools/browser/replaced'
if((Snapshot) -ceq $baseline){throw 'Replacement browser instance was accepted'}
$script:browserInstance='ws://127.0.0.1:9223/devtools/browser/instance-one'
$script:workerPid=201
if((Snapshot) -ceq $baseline){throw 'Replacement authenticated worker was accepted'}
@{ok=$true;status='RELEASE_BROWSER_CONTINUITY_REGRESSION_PASS';transientChildrenAllowed=$true;pageReplacementRejected=$true;browserReplacementRejected=$true;workerReplacementRejected=$true;productionChanged=$false} | ConvertTo-Json
