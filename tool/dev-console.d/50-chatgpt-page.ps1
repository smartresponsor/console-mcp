function Get-ChatgptPageStatus {
    param([string]$Purpose = 'manual')
    Invoke-BrowserEnsureVisible -Purpose "chatgpt-page-$Purpose" | Out-Null
    $targets = @(Invoke-RestMethod 'http://127.0.0.1:9223/json/list' -TimeoutSec 5)
    $chat = @($targets | Where-Object { $_.type -eq 'page' -and $_.url -match '^https://chatgpt\.com' })
    $root = @($chat | Where-Object { $_.url -in @('https://chatgpt.com/','https://chatgpt.com') })
    $settings = @($chat | Where-Object { $_.url -match '#settings' })
    $selected = @(if ($root.Count) { $root[0] } elseif ($chat.Count) { $chat[0] } else { $null })[0]
    $result = [pscustomobject]@{
        ok = [bool]$selected
        status = if ($selected) { 'CHATGPT_PAGE_PRESENT' } else { 'CHATGPT_PAGE_MISSING' }
        purpose = $Purpose
        at = (Get-Date).ToString('o')
        target_count = $targets.Count
        chatgpt_target_count = $chat.Count
        root_target_count = $root.Count
        settings_target_count = $settings.Count
        noise_target_count = ($targets.Count - $chat.Count)
        selected_target_id = if ($selected) { $selected.id } else { $null }
        selected_url = if ($selected) { $selected.url } else { $null }
        selected_title = if ($selected) { $selected.title } else { $null }
        next_action = if ($selected) { 'classify_session' } else { 'open_chatgpt_page' }
    }
    Write-StateArtifact -Directory $BrowserStateDir -Name (New-StackOperationId -Purpose "chatgpt-page-$Purpose") -Payload $result | Out-Null
    return $result
}

Set-Variable -Name DevConsoleChatgptPageModuleLoaded -Scope Script -Value $true -Force
