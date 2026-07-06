import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../service/auth.js";
import type { ConsolePolicy } from "../service/policy.js";
import { buildSafeEnv, resolveCommandExecutable, sanitizeText } from "../service/process.js";
import { buildConsoleToolRegistration, textResult, truncateText } from "./common.js";

const execFileAsync = promisify(execFile);
const defaultPorts = [9223, 3333, 3334, 8791, 8792, 8000, 5173, 3000] as const;
const defaultHealthUrls = ["http://127.0.0.1:9223/json/version", "http://127.0.0.1:8791/healthz", "http://127.0.0.1:8792/healthz"] as const;

type Input = {
  ports?: number[];
  healthUrls?: string[];
  includeBrowserProcesses?: boolean;
  includeListeners?: boolean;
  includeHealthUrls?: boolean;
  includeRawDetails?: boolean;
  timeoutMs?: number;
};

const inputSchema = z.object({
  ports: z.array(z.number().int().min(1).max(65535)).max(50).optional(),
  healthUrls: z.array(z.string().min(1)).max(20).optional(),
  includeBrowserProcesses: z.boolean().optional(),
  includeListeners: z.boolean().optional(),
  includeHealthUrls: z.boolean().optional(),
  includeRawDetails: z.boolean().optional(),
  timeoutMs: z.number().int().min(1000).max(30000).optional(),
}).strict();

export function registerBrowserSessionTool(server: McpServer, authConfig: ConsoleAuthConfig): void {
  server.registerTool("console.read_.browser.edge.session.status", {
    description: "Read-only Windows browser/session diagnostic for Chrome/Edge/Chromium processes, visible windows, loopback listeners, and loopback health URLs.",
    inputSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(await inspectBrowserSession(input)));
}

async function inspectBrowserSession(input: Input): Promise<Record<string, unknown>> {
  const options = normalizeInput(input);
  const payload = {
    ports: options.includeListeners ? options.ports : [],
    healthUrls: options.includeHealthUrls ? options.healthUrls : [],
    includeBrowserProcesses: options.includeBrowserProcesses,
    timeoutSeconds: Math.max(1, Math.ceil(options.timeoutMs / 1000)),
  };
  const execution = await runPowerShell(payload, options.timeoutMs);
  const stdout = execution.stdout.trim();
  const stderr = execution.stderr.trim();

  try {
    const result = JSON.parse(stdout) as Record<string, unknown>;
    const sharedBrowser = await readSharedBrowserRegistry();
    return compactBrowserSessionResult(result, sharedBrowser, stderr, options.includeRawDetails);
  } catch {
    return {
      ok: false,
      status: "BROWSER_SESSION_STATUS_NON_JSON",
      mode: "safe-browser-session-status-readonly",
      error: "browser_session_status returned non-JSON output",
      stdout_preview: truncateText(sanitizeText(stdout), 4000).text,
      stderr_preview: stderr.length > 0 ? truncateText(sanitizeText(stderr), 4000).text : null,
    };
  }
}

async function readSharedBrowserRegistry(): Promise<Record<string, unknown>> {
  const runtimeFile = path.resolve(process.cwd(), "..", "browser", "run", "browser-runtime.json");
  try {
    const registry = JSON.parse(await readFile(runtimeFile, "utf8")) as Record<string, unknown>;
    return { ok: true, runtime_file: runtimeFile, registry };
  } catch (error) {
    return { ok: false, runtime_file: runtimeFile, error: error instanceof Error ? error.message : String(error) };
  }
}

function normalizeInput(input: Input): Required<Input> {
  const timeoutMs = input.timeoutMs ?? 10000;
  const ports = uniquePorts(input.ports ?? [...defaultPorts]);
  const healthUrls = uniqueUrls(input.healthUrls ?? [...defaultHealthUrls]);
  return {
    ports,
    healthUrls,
    includeBrowserProcesses: input.includeBrowserProcesses ?? true,
    includeListeners: input.includeListeners ?? true,
    includeHealthUrls: input.includeHealthUrls ?? true,
    includeRawDetails: input.includeRawDetails ?? false,
    timeoutMs,
  };
}

function compactBrowserSessionResult(result: Record<string, unknown>, sharedBrowser: Record<string, unknown>, stderr: string, includeRawDetails: boolean): Record<string, unknown> {
  const summary = asRecord(result.summary);
  const diagnostic = asRecord(result.diagnostic);
  const browserProcesses = asRecords(result.browser_processes);
  const listeners = asRecords(result.listeners);
  const health = asRecords(result.health);
  const visibleCount = numberOrZero(summary.visible_browser_window_count);
  const browserCount = numberOrZero(summary.browser_process_count);
  const backgroundCount = numberOrZero(summary.background_browser_process_count);
  const listenerOpenCount = numberOrZero(summary.listener_open_count);
  const healthOkCount = numberOrZero(summary.health_ok_count);
  const browserStatus = visibleCount > 0 ? "BROWSER_WINDOW_VISIBLE" : (browserCount > 0 ? "BROWSER_BACKGROUND_ONLY" : "BROWSER_NOT_FOUND");
  const listenerStatus = listeners.length === 0 ? "LISTENERS_NOT_REQUESTED" : (listenerOpenCount > 0 ? "LISTENERS_OPEN" : "LISTENERS_CLOSED");
  const healthStatus = health.length === 0 ? "HEALTH_NOT_REQUESTED" : (healthOkCount === health.length ? "HEALTH_OK" : (healthOkCount > 0 ? "HEALTH_PARTIAL" : "HEALTH_FAILED"));
  const ok = result.ok === true;
  const status = ok && visibleCount > 0 ? "BROWSER_SESSION_READY" : (ok ? "BROWSER_SESSION_DIAGNOSTIC_READY" : "BROWSER_SESSION_DIAGNOSTIC_FAILED");
  const compact: Record<string, unknown> = {
    ok,
    status,
    mode: result.mode ?? "safe-browser-session-status-readonly",
    policy: result.policy ?? null,
    summary: {
      browser_process_count: browserCount,
      visible_browser_window_count: visibleCount,
      headless_browser_process_count: numberOrZero(summary.headless_browser_process_count),
      background_browser_process_count: backgroundCount,
      listener_open_count: listenerOpenCount,
      health_ok_count: healthOkCount,
    },
    browser: {
      status: browserStatus,
      process_count: browserCount,
      visible_window_count: visibleCount,
      background_process_count: backgroundCount,
      headless_process_count: numberOrZero(summary.headless_browser_process_count),
      has_visible_browser_window: diagnostic.has_visible_browser_window === true,
      likely_issue: diagnostic.likely_issue ?? null,
    },
    listeners: {
      status: listenerStatus,
      requested_count: listeners.length,
      open_count: listenerOpenCount,
      ports: listeners.map((listener) => ({ port: listener.port ?? null, open: listener.open === true })),
    },
    health: {
      status: healthStatus,
      requested_count: health.length,
      ok_count: healthOkCount,
      urls: health.map((item) => ({ url: item.url ?? null, ok: item.ok === true, status_code: item.status_code ?? null })),
    },
    shared_browser: sharedBrowser,
    powershell_stderr: stderr.length > 0 ? truncateText(sanitizeText(stderr), 2000).text : null,
  };
  if (includeRawDetails) {
    compact.raw_details = {
      diagnostic,
      browser_processes: browserProcesses,
      listeners,
      health,
    };
  }
  return compact;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item)) : [];
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function uniquePorts(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0 && value <= 65535))].slice(0, 50);
}

function uniqueUrls(values: string[]): string[] {
  return [...new Set(values.map((value) => validateLoopbackUrl(value)))].slice(0, 20);
}

function validateLoopbackUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http and https loopback URLs are allowed: ${sanitizeUrl(url)}`);
  }
  if (url.username || url.password) {
    throw new Error("Credentials in loopback URLs are not allowed.");
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new Error(`Only loopback hosts are allowed: ${sanitizeUrl(url)}`);
  }
  return sanitizeUrl(url);
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const parts = host.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number.parseInt(part, 10) >= 0 && Number.parseInt(part, 10) <= 255);
}

function sanitizeUrl(url: URL): string {
  const clone = new URL(url.href);
  clone.username = "";
  clone.password = "";
  for (const key of Array.from(clone.searchParams.keys())) {
    if (/(token|secret|password|passwd|pwd|key|auth|session|csrf|xsrf|signature|sig|code|state)/i.test(key)) {
      clone.searchParams.set(key, "[redacted]");
    }
  }
  return clone.href;
}

async function runPowerShell(payload: Record<string, unknown>, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  const executable = resolveCommandExecutable("pwsh");
  const encoded = Buffer.from(buildScript(JSON.stringify(payload)), "utf16le").toString("base64");
  const { stdout, stderr } = await execFileAsync(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    timeout: timeoutMs + 5000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    env: buildSafeEnv(),
  });
  return { stdout: sanitizeText(stdout), stderr: sanitizeText(stderr) };
}

function buildScript(payloadJson: string): string {
  const escapedPayload = payloadJson.replace(/'/g, "''");
  return String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$payload = '${escapedPayload}' | ConvertFrom-Json

function ConvertTo-SafeText {
    param([AllowNull()][object]$Value)
    if ($null -eq $Value) { return $null }
    $text = [string]$Value
    $text = $text -replace '(?i)(Authorization:\s*Bearer\s+)[^\s"]+', '$1[redacted]'
    $text = $text -replace '(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+\b', 'Bearer [redacted]'
    $text = $text -replace 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+', '[redacted-jwt]'
    $text = $text -replace '(?i)\b(client_secret|authorization_code|refresh_token|access_token|token|code|password|secret)\b\s*[:=]\s*[^,\s"]+', '$1=[redacted]'
    $text = $text -replace '(?i)([?&](?:token|code|refresh_token|client_secret|access_token|password|secret)=[^&\s]+)', '[redacted]'
    return $text
}

function Get-CommandFlag {
    param([string]$CommandLine, [string]$Name)
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $null }
    $pattern = '--' + [regex]::Escape($Name) + '=(?:"(?<q>[^"]+)"|(?<u>[^\s]+))'
    $match = [regex]::Match($CommandLine, $pattern)
    if (-not $match.Success) { return $null }
    if ($match.Groups['q'].Success) { return ConvertTo-SafeText $match.Groups['q'].Value }
    return ConvertTo-SafeText $match.Groups['u'].Value
}

function Test-HasFlag {
    param([string]$CommandLine, [string]$Name)
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
    return $CommandLine -match ('(^|\s)--' + [regex]::Escape($Name) + '(=|\s|$)')
}

function Get-BrowserProcesses {
    $names = @('chrome.exe', 'chromium.exe', 'msedge.exe')
    @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $names -contains $_.Name } |
        ForEach-Object {
            $process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
            $commandLine = [string]$_.CommandLine
            [pscustomobject]@{
                pid = [int]$_.ProcessId
                name = [string]$_.Name
                responding = $(if ($process) { [bool]$process.Responding } else { $null })
                main_window_handle = $(if ($process) { [int64]$process.MainWindowHandle } else { 0 })
                main_window_visible = [bool]($process -and $process.MainWindowHandle -ne 0)
                main_window_title = $(if ($process) { ConvertTo-SafeText $process.MainWindowTitle } else { $null })
                start_time = $(try { if ($process) { $process.StartTime.ToString('o') } else { $null } } catch { $null })
                headless = [bool]($commandLine -match '--headless')
                user_data_dir = Get-CommandFlag $commandLine 'user-data-dir'
                remote_debugging_port = Get-CommandFlag $commandLine 'remote-debugging-port'
                profile_directory = Get-CommandFlag $commandLine 'profile-directory'
                app_mode = Test-HasFlag $commandLine 'app'
                automation_controlled = [bool]($commandLine -match '--enable-automation|--remote-debugging-pipe|--remote-debugging-port')
            }
        } |
        Sort-Object -Property name,pid)
}

function Get-ListenerReport {
    param([int[]]$Ports)
    $out = @()
    foreach ($port in $Ports) {
        $connections = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue -ProgressAction SilentlyContinue)
        if ($connections.Count -eq 0) {
            $out += [pscustomobject]@{ port = $port; open = $false; listeners = @() }
            continue
        }
        $listeners = @($connections | ForEach-Object {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($_.OwningProcess)" -ErrorAction SilentlyContinue
            [pscustomobject]@{
                local_address = [string]$_.LocalAddress
                pid = [int]$_.OwningProcess
                process_name = $(if ($proc) { [string]$proc.Name } else { $null })
                command = $(if ($proc) { ConvertTo-SafeText (([string]$proc.CommandLine) -replace '^"?([^"\s]+).*$', '$1') } else { $null })
            }
        })
        $out += [pscustomobject]@{ port = $port; open = $true; listeners = $listeners }
    }
    return $out
}

function Invoke-LoopbackHealth {
    param([string[]]$Urls, [int]$TimeoutSeconds)
    $out = @()
    foreach ($url in $Urls) {
        try {
            $response = Invoke-WebRequest -Uri $url -Method Get -TimeoutSec $TimeoutSeconds -SkipHttpErrorCheck -ErrorAction Stop
            $text = ConvertTo-SafeText ([string]$response.Content)
            $body = if ($text.Length -gt 4096) { $text.Substring(0, 4096) } else { $text }
            $json = $null
            try { $json = $body | ConvertFrom-Json -ErrorAction Stop } catch { $json = $null }
            $out += [pscustomobject]@{
                url = $url
                ok = [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 400
                status_code = [int]$response.StatusCode
                content_type = [string]$response.Headers['Content-Type']
                json = $json
                body_preview = if ($json) { $null } else { $body }
            }
        } catch {
            $out += [pscustomobject]@{ url = $url; ok = $false; status_code = $null; error = ConvertTo-SafeText $_.Exception.Message }
        }
    }
    return $out
}

$browser = if ($payload.includeBrowserProcesses) { @(Get-BrowserProcesses) } else { @() }
$listeners = @(Get-ListenerReport -Ports @($payload.ports))
$health = @(Invoke-LoopbackHealth -Urls @($payload.healthUrls) -TimeoutSeconds ([int]$payload.timeoutSeconds))
$visible = @($browser | Where-Object { $_.main_window_visible -eq $true })
$headless = @($browser | Where-Object { $_.headless -eq $true })
$blocked = @($browser | Where-Object { $_.headless -ne $true -and $_.main_window_visible -ne $true })

[pscustomobject]@{
    ok = $true
    mode = 'safe-browser-session-status-readonly'
    policy = [pscustomobject]@{
        browser_mutation = 'denied'
        external_network = 'denied'
        local_http_methods = @('GET')
        inspected_process_names = @('chrome.exe', 'chromium.exe', 'msedge.exe')
    }
    summary = [pscustomobject]@{
        browser_process_count = $browser.Count
        visible_browser_window_count = $visible.Count
        headless_browser_process_count = $headless.Count
        background_browser_process_count = $blocked.Count
        listener_open_count = @($listeners | Where-Object { $_.open -eq $true }).Count
        health_ok_count = @($health | Where-Object { $_.ok -eq $true }).Count
    }
    diagnostic = [pscustomobject]@{
        has_visible_browser_window = $visible.Count -gt 0
        browser_claim_can_be_false_positive = $blocked.Count -gt 0
        likely_issue = if ($visible.Count -eq 0 -and $browser.Count -gt 0) { 'browser processes exist but no visible main window was detected' } elseif ($browser.Count -eq 0) { 'no Chrome/Edge/Chromium process detected' } else { $null }
    }
    browser_processes = $browser
    listeners = $listeners
    health = $health
} | ConvertTo-Json -Depth 10
`;
}
