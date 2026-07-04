function Get-ChatgptSessionStatus {
    param([string]$Purpose = 'manual')
    Get-ChatgptPageStatus -Purpose "session-$Purpose" | Out-Null
    $scriptPath = Join-Path $Root 'tool\chatgpt-session-status.mjs'
    $node = Get-NodeCommand
    $raw = & $node.Source $scriptPath --ports '9222,9223' --timeoutMs 5000 2>&1
    $exitCode = $LASTEXITCODE
    $text = (($raw | Out-String).Trim())
    if ([string]::IsNullOrWhiteSpace($text)) { $text = '{"ok":false,"status":"EMPTY_SESSION_STATUS_OUTPUT"}' }
    try { $result = $text | ConvertFrom-Json } catch { $result = [pscustomobject]@{ ok = $false; status = 'SESSION_STATUS_UNPARSEABLE'; error = Sanitize-Text $_.Exception.Message; raw = Sanitize-Text $text } }
    $result | Add-Member -NotePropertyName purpose -NotePropertyValue $Purpose -Force
    $result | Add-Member -NotePropertyName at -NotePropertyValue (Get-Date).ToString('o') -Force
    $result | Add-Member -NotePropertyName exit_code -NotePropertyValue $exitCode -Force
    Write-StateArtifact -Directory $BrowserStateDir -Name (New-StackOperationId -Purpose "chatgpt-session-$Purpose") -Payload $result | Out-Null
    return $result
}

Set-Variable -Name DevConsoleChatgptSessionModuleLoaded -Scope Script -Value $true -Force
