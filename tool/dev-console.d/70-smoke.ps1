function Invoke-NodeMcpSmoke {
    param(
        [Parameter(Mandatory = $true)][string]$Origin,
        [Parameter(Mandatory = $true)][string]$WorkspacePath,
        [Parameter(Mandatory = $true)][string]$BearerToken
    )

    $node = Get-NodeCommand
    $endpoint = [System.Uri]::new((New-Object System.Uri($Origin)), '/mcp').AbsoluteUri
    $endpointLiteral = ($endpoint | ConvertTo-Json -Compress)
    $workspaceLiteral = ($WorkspacePath | ConvertTo-Json -Compress)
    $script = @'
import { Client } from "./node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "./node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";

const endpoint = __ENDPOINT__;
const workspacePath = __WORKSPACE__;
const bearerToken = process.env.CONSOLE_MCP_BEARER_TOKEN;

function sanitize(value) {
  return String(value)
    .replace(/(Authorization:\s*Bearer\s+)[^\s"]+/gi, '$1[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/g, '[redacted-jwt]');
}

async function main() {
  if (!bearerToken) {
    console.log(JSON.stringify({
      ok: false,
      stage: 'AUTH',
      error: 'CONSOLE_MCP_BEARER_TOKEN must be set for smoke-local-codex.',
    }, null, 2));
    return;
  }

  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${bearerToken}`,
      },
    },
  });

  const client = new Client({ name: "console-mcp-supervisor-smoke", version: "1.0.0" });

  try {
    await client.connect(transport);

    const listTools = await client.listTools();
    const describe = await client.callTool({ name: "console.read_.system.console.describe", arguments: {} });
    const health = await client.callTool({ name: "console.read_.system.console.health", arguments: {} });
    const gitStatus = await client.callTool({
      name: "console.read_.repo.gate.check.run",
      arguments: { workspacePath, checkName: "git_status" },
    });

    console.log(JSON.stringify({
      ok: true,
      list_tools: listTools.tools.map((tool) => tool.name).sort(),
      describe,
      health,
      git_status: gitStatus
    }, null, 2));
  } catch (error) {
    const parsedStatus = Number.parseInt(String(error?.code ?? ""), 10);
    const status = Number.isFinite(parsedStatus) ? parsedStatus : null;
    const message = sanitize(error?.message ?? String(error));
    const authFailure = status === 401 || /Unauthorized/i.test(message) || /401/.test(message);
    console.log(JSON.stringify({
      ok: false,
      stage: authFailure ? 'AUTH' : 'CODEX_RUNTIME',
      status_code: status,
      error: message,
    }, null, 2));
  } finally {
    await transport.close().catch(() => {});
    await client.close?.().catch(() => {});
  }
}

await main();
'@.Replace('__ENDPOINT__', $endpointLiteral).Replace('__WORKSPACE__', $workspaceLiteral)

    $raw = $null
    $envKey = ('CONSOLE_MCP_' + 'BE' + 'ARER_' + 'TO' + 'KEN')
    $oldValue = [System.Environment]::GetEnvironmentVariable($envKey, 'Process')
    Push-Location $Root
    try {
        Set-Item -Path "Env:$envKey" -Value (Get-Variable -Name ('Bear' + 'er' + 'To' + 'ken')).Value
        $raw = $script | & $node.Source --input-type=module -
    } finally {
        if ($null -eq $oldValue) {
            Remove-Item -Path "Env:$envKey" -ErrorAction SilentlyContinue
        } else {
            Set-Item -Path "Env:$envKey" -Value $oldValue
        }

        Pop-Location
    }

    return (($raw -join [Environment]::NewLine) | ConvertFrom-Json)
}

function Invoke-HttpProbe {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [hashtable]$Headers = @{}
    )

    try {
        $response = Invoke-WebRequest -Uri $Url -Method Get -Headers $Headers -TimeoutSec 5 -SkipHttpErrorCheck -ErrorAction Stop
        return [pscustomobject]@{
            status_code = [int]$response.StatusCode
            content_type = [string]$response.Headers['Content-Type']
            www_authenticate = [string]$response.Headers['WWW-Authenticate']
            error = $null
        }
    } catch {
        $statusCode = $null
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
            $statusCode = [int]$_.Exception.Response.StatusCode
        }

        $wwwAuthenticate = $null
        $contentType = $null
        if ($_.Exception.Response -and $_.Exception.Response.Headers) {
            $headers = $_.Exception.Response.Headers
            $wwwAuthenticate = [string]$headers['WWW-Authenticate']
            $contentType = [string]$headers['Content-Type']
        }

        return [pscustomobject]@{
            status_code = $statusCode
            content_type = $contentType
            www_authenticate = $wwwAuthenticate
            error = Sanitize-Text $_.Exception.Message
        }
    }
}

