$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$npm = Get-Command npm -ErrorAction Stop
$node = Get-Command node -ErrorAction Stop
$curl = Get-Command curl.exe -ErrorAction Stop

if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules'))) {
    & $npm.Source install
}

& $npm.Source run build

$originalAuthMode = $env:CONSOLE_MCP_AUTH_MODE
$originalBearerToken = $env:CONSOLE_MCP_BEARER_TOKEN
$originalTrace = $env:CONSOLE_MCP_TRACE
$transcriptDir = Join-Path $root 'var/transcript'
$httpTracePath = Join-Path $transcriptDir 'http-trace.ndjson'
if (Test-Path -LiteralPath $httpTracePath) {
    Remove-Item -LiteralPath $httpTracePath -Force
}
$port = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
try {
    $port.Start()
    $freePort = ([System.Net.IPEndPoint]$port.LocalEndpoint).Port
} finally {
    $port.Stop()
}

$env:CONSOLE_MCP_HOST = '127.0.0.1'
$env:CONSOLE_MCP_PORT = $freePort.ToString()
$env:CONSOLE_MCP_AUTH_MODE = 'bearer'
$env:CONSOLE_MCP_TRACE = '1'
$token = ([Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N'))
$env:CONSOLE_MCP_BEARER_TOKEN = $token

$server = Start-Process -FilePath $node.Source -ArgumentList @('dist/index.js') -WorkingDirectory $root -PassThru -WindowStyle Hidden
try {
    for ($i = 0; $i -lt 60; $i++) {
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$freePort/mcp" -Method Get -TimeoutSec 2 -SkipHttpErrorCheck -ErrorAction Stop
            if ($response.StatusCode -in 200, 401, 404, 405) {
                break
            }
        } catch {
            $statusCode = $null
            if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
                $statusCode = [int]$_.Exception.Response.StatusCode
            }

            if ($statusCode -in 200, 401, 404, 405) {
                break
            }

            Start-Sleep -Milliseconds 250
        }
    }

    $missingTokenStatus = & $curl.Source -sS -o NUL -w '%{http_code}' --http1.1 "http://127.0.0.1:$freePort/mcp"
    $wrongTokenStatus = & $curl.Source -sS -o NUL -w '%{http_code}' --http1.1 -H 'Authorization: Bearer definitely-wrong-token' "http://127.0.0.1:$freePort/mcp"
    $goodTokenStatus = & $curl.Source -sS -o NUL -w '%{http_code}' --http1.1 -H "Authorization: Bearer $token" "http://127.0.0.1:$freePort/mcp"

    $script = @"
import { Client } from './node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from './node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:$freePort/mcp'), {
  requestInit: {
    headers: {
      Authorization: 'Bearer $token',
    },
  },
});

const client = new Client({ name: 'console-mcp-smoke', version: '1.0.0' });
await client.connect(transport);

const listTools = await client.listTools();
const call = async (name, args) => client.callTool({ name, arguments: args });
const workspace = 'D:\\PhpstormProjects\\www\\Ordering';

console.log(JSON.stringify({
  list_tools: listTools.tools.map((tool) => tool.name).sort(),
  describe: await call('console.read_.system.console.describe', {}),
  health: await call('console.read_.system.console.health', {}),
  workspace_status: await call('console.read_.repo.workspace.status', { workspacePath: workspace }),
  capture_context: await call('console.read_.repo.context.capture', { workspacePath: workspace }),
  search_text: await call('console.read_.repo.text.search', { workspacePath: 'D:\\PhpstormProjects\\www\\console-mcp', query: 'console-mcp', maxResults: 3 }),
  read_file_refusal: await call('console.read_.repo.file.read', { filePath: 'D:\\PhpstormProjects\\www\\.env' }),
  unknown_check_refusal: await call('console.read_.repo.gate.check.run', { workspacePath: 'D:\\PhpstormProjects\\www', checkName: 'unknown_check' }),
  git_status: await call('console.read_.repo.gate.check.run', { workspacePath: workspace, checkName: 'git_status' })
}, null, 2));

await transport.close();
"@

    Push-Location $root
    try {
        $script | & $node.Source --input-type=module -
    } finally {
        Pop-Location
    }

    Write-Output "missing_token_http=$missingTokenStatus"
    Write-Output "wrong_token_http=$wrongTokenStatus"
    Write-Output "good_token_http=$goodTokenStatus"

    if (-not (Test-Path -LiteralPath $httpTracePath)) {
        throw "http trace was not written."
    }

    $traceLines = Get-Content -LiteralPath $httpTracePath
    if ($traceLines.Count -lt 1) {
        throw "http trace is empty."
    }

    foreach ($line in $traceLines) {
        $entry = $line | ConvertFrom-Json
        if (-not ($entry.PSObject.Properties.Name -contains 'path')) {
            throw "http trace entry missing path."
        }
        if (-not ($entry.PSObject.Properties.Name -contains 'status_code')) {
            throw "http trace entry missing status_code."
        }
        if ($entry.PSObject.Properties.Name -contains 'authorization') {
            throw "http trace leaked raw authorization content."
        }
        if ($entry.authorization_scheme -and $entry.authorization_scheme -notin @('Bearer')) {
            throw "http trace authorization scheme is unexpected."
        }
    }
} finally {
    if ($server -and -not $server.HasExited) {
        Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $originalBearerToken) {
        $env:CONSOLE_MCP_BEARER_TOKEN = $originalBearerToken
    } else {
        Remove-Item Env:CONSOLE_MCP_BEARER_TOKEN -ErrorAction SilentlyContinue
    }
    if ($null -ne $originalAuthMode) {
        $env:CONSOLE_MCP_AUTH_MODE = $originalAuthMode
    } else {
        Remove-Item Env:CONSOLE_MCP_AUTH_MODE -ErrorAction SilentlyContinue
    }
    if ($null -ne $originalTrace) {
        $env:CONSOLE_MCP_TRACE = $originalTrace
    } else {
        Remove-Item Env:CONSOLE_MCP_TRACE -ErrorAction SilentlyContinue
    }
}
