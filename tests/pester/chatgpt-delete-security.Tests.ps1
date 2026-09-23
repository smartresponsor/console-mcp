$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$sourcePath = Join-Path $repositoryRoot 'src/tool/chatgpt-chat-open.ts'

Describe 'ChatGPT authenticated delete broker' {
    It 'keeps credentials inside browser page context' {
        $source = Get-Content -LiteralPath $sourcePath -Raw
        $brokerMatch = [regex]::Match(
            $source,
            '(?s)async function tryDeleteConversationViaAuthenticatedTarget\(.*?function buildDeleteConversationExpression'
        )

        $brokerMatch.Success | Should Be $true
        $broker = $brokerMatch.Value
        $broker | Should Match 'buildAuthenticatedDeleteConversationExpression'
        $broker | Should Match "'/api/auth/session'"
        $broker | Should Match "Authorization: 'Bearer ' \+ accessToken"
        $broker | Should Match 'auth_token_present'
        $broker | Should Not Match 'access_token\s*:\s*accessToken'
        $broker | Should Not Match 'return\s+\{[^}]*accessToken'
    }

    It 'falls back to the existing exact-chat delete path when no authenticated target succeeds' {
        $source = Get-Content -LiteralPath $sourcePath -Raw
        $source | Should Match 'tryDeleteConversationViaAuthenticatedTarget\(input\.ports, liveTarget, input\.expectedChatId'
        $source | Should Match 'brokerDelete\.ok === true'
        $source | Should Match 'buildDeleteConversationExpression\(input\.expectedChatId, input\.closeTarget\)'
        $source | Should Match 'CHAT_DELETE_AUTHENTICATED_TARGET_UNAVAILABLE'
    }

    It 'keeps WEB-prefixed chat ids aligned across parser planner and sanitizer' {
        $paths = @(
            'src/service/chatgpt-artifact-guard.ts',
            'src/Consumer/ChatGpt/Target/ChatGptTargetPlanner.ts',
            'src/Runtime/Browser/BrowserSessionSanitizer.ts'
        )
        foreach ($path in $paths) {
            $content = Get-Content -LiteralPath (Join-Path $repositoryRoot $path) -Raw
            $content | Should Match 'CHAT_ID_PATTERN = /\^\(\?:WEB:\)\?\[A-Za-z0-9_-\]\+\$/'
        }
    }
}
