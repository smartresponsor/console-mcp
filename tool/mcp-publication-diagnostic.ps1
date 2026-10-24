param()
$ErrorActionPreference = 'Stop'
$local = 'http://127.0.0.1:3333'
$metadataPath = '/.well-known/oauth-protected-resource'
$metadata = Invoke-RestMethod -Uri ($local + $metadataPath) -TimeoutSec 10
$resource = [uri]$metadata.resource
if ($resource.Scheme -ne 'https' -or $resource.UserInfo -or -not $resource.Host) {
    throw 'Local OAuth metadata did not advertise a safe HTTPS resource'
}
$external = $resource.GetLeftPart([System.UriPartial]::Authority)
$externalMetadata = Invoke-RestMethod -Uri ($external + $metadataPath) -TimeoutSec 10
function Read-ToolSchema([string]$Origin) {
    $headers = @{ Accept = 'application/json, text/event-stream' }
    if ($env:CONSOLE_MCP_DIAGNOSTIC_OAUTH_TOKEN) {
        $headers.Authorization = 'Bearer ' + $env:CONSOLE_MCP_DIAGNOSTIC_OAUTH_TOKEN
    }
    function Rpc([string]$Method, $Params, [int]$Id) {
        $body = @{ jsonrpc = '2.0'; id = $Id; method = $Method; params = $Params } | ConvertTo-Json -Depth 10 -Compress
        Invoke-WebRequest -Uri ($Origin + '/mcp') -Method Post -Headers $headers -ContentType 'application/json' -Body $body -SkipHttpErrorCheck -TimeoutSec 15
    }
    function Decode($Response) {
        $text = [string]$Response.Content
        if ($text -match '(?m)^data: (.+)$') { $text = $Matches[1] }
        $text | ConvertFrom-Json -Depth 50
    }
    $init = Rpc 'initialize' @{ protocolVersion = '2024-11-05'; capabilities = @{}; clientInfo = @{ name = 'publication-diagnostic'; version = '1' } } 1
    if ([int]$init.StatusCode -ne 200) {
        return [pscustomobject]@{ origin = $Origin; status = [int]$init.StatusCode; stage = 'initialize'; schema = $null }
    }
    if ($init.Headers['Mcp-Session-Id']) { $headers['Mcp-Session-Id'] = [string]($init.Headers['Mcp-Session-Id'] | Select-Object -First 1) }
    $headers['MCP-Protocol-Version'] = [string](Decode $init).result.protocolVersion
    $null = Invoke-WebRequest -Uri ($Origin + '/mcp') -Method Post -Headers $headers -ContentType 'application/json' -Body '{"jsonrpc":"2.0","method":"notifications/initialized"}' -SkipHttpErrorCheck -TimeoutSec 15
    $response = Rpc 'tools/list' @{} 2
    $schema = $null
    if ([int]$response.StatusCode -eq 200) {
        $page = Decode $response
        $tools = @($page.result.tools)
        while ($page.result.nextCursor) {
            $page = Decode (Rpc 'tools/list' @{ cursor = $page.result.nextCursor } 3)
            $tools += @($page.result.tools)
        }
        $tool = $tools | Where-Object name -eq 'write.web.form.proposal.preview' | Select-Object -First 1
        $schema = $tool.inputSchema
    }
    [pscustomobject]@{ origin = $Origin; status = [int]$response.StatusCode; stage = 'tools/list'; schema = $schema }
}
$localSchema = Read-ToolSchema $local
$externalSchema = Read-ToolSchema $external
[pscustomobject]@{
    local_resource = $metadata.resource
    external_origin = $external
    external_resource = $externalMetadata.resource
    resource_matches = $metadata.resource -eq $externalMetadata.resource
    local = $localSchema
    external = $externalSchema
    schema_comparison_available = [bool]($localSchema.schema -and $externalSchema.schema)
    schemas_equal = if ($localSchema.schema -and $externalSchema.schema) { ($localSchema.schema | ConvertTo-Json -Depth 50 -Compress) -eq ($externalSchema.schema | ConvertTo-Json -Depth 50 -Compress) } else { $null }
} | ConvertTo-Json -Depth 50
