# A runtime prompt is executable task policy and must be bound to the transaction.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'test-fixture.ps1')
. (Join-Path $PSScriptRoot 'dev-console.d/88-release-v3-authority.ps1')
$fixture=New-ConsoleTestFixture -Prefix 'release-prompt'
try {
 foreach($part in @('dist','node_modules','prompt/chatgpt')){$null=[IO.Directory]::CreateDirectory((Join-Path $fixture $part))}
 [IO.File]::WriteAllText((Join-Path $fixture 'dist/index.js'),'inert descriptor fixture')
 $prompt=Join-Path $fixture 'prompt/chatgpt/task.md'
 [IO.File]::WriteAllText($prompt,'original approved task policy')
 $descriptor=Get-ReleaseV3Descriptor $fixture ('a'*40)
 $relative=[IO.Path]::GetRelativePath($fixture,$prompt)
 if(-not $descriptor.files.Contains($relative)){throw 'Runtime prompt omitted from release coverage'}
 Test-ReleaseV3Descriptor $descriptor
 [IO.File]::WriteAllText($prompt,'changed task policy')
 $rejected=$false
 try{Test-ReleaseV3Descriptor $descriptor}catch{if($_.Exception.Message -ne 'RELEASE_CONTENT_DRIFT'){throw};$rejected=$true}
 if(-not $rejected){throw 'Runtime prompt drift was accepted'}
 @{ok=$true;status='RELEASE_PROMPT_COVERAGE_PASS';promptDriftRejected=$true;productionChanged=$false} | ConvertTo-Json
}finally{Remove-ConsoleTestFixture $fixture}
