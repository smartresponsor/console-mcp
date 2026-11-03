$ErrorActionPreference='Stop'
$root=Resolve-Path (Join-Path $PSScriptRoot '..')
$browsing='/home/alex/smartresponse/mcp/.worktrees/browsing-web-quota-20261102'
$link='/home/alex/smartresponse/mcp/.worktrees/browsing'
if(Test-Path -LiteralPath $link){throw 'TEST_BROWSING_LINK_ALREADY_EXISTS'}
if(!(Test-Path -LiteralPath $browsing)){throw 'TEST_BROWSING_SOURCE_MISSING'}
& /usr/bin/ln -s $browsing $link
if($LASTEXITCODE -ne 0){throw 'TEST_BROWSING_LINK_CREATE_FAILED'}
Push-Location $root
try {
 foreach($file in @('tool/web-domain-bridge-regression.mjs','tool/grants-session-admission-regression.mjs','tool/web-outcome-policy-regression.mjs')){
  & /usr/bin/node $file
  if($LASTEXITCODE -ne 0){throw ('REGRESSION_FAILED '+$file)}
 }
}finally{
 Pop-Location
 & /usr/bin/unlink $link
 if($LASTEXITCODE -ne 0){throw 'TEST_BROWSING_LINK_CLEANUP_FAILED'}
}
