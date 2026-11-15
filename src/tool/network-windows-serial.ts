/**
 * Passive Windows COM/USB serial inventory.
 * The fixed PowerShell CIM script enumerates devices without opening ports.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../tool/network-windows-serial-inventory.ps1", import.meta.url));
const MAX_BYTES = 65536;
const MAX_PORTS = 64;
const TIMEOUT_MS = 15000;

type WindowsPort = {
  device: string;
  driver: null;
  sysfsPath: null;
  friendlyName: string | null;
  manufacturer: string | null;
  transport: "usb" | "bluetooth" | "unknown";
  vid: string | null;
  pid: string | null;
  status: string | null;
};

type WindowsInventory = {
  ok: boolean;
  platform: "win32";
  source: string;
  reason?: string;
  truncated: boolean;
  ports: WindowsPort[];
};

const failure = (reason: string): WindowsInventory => ({
  ok: false, platform: "win32", source: "Windows CIM", reason, truncated: false, ports: [],
});

function dict(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
function safeText(value: unknown): string | null {
  return typeof value === "string" && value.length <= 256 && !/[\u0000-\u001f]/.test(value) ? value : null;
}

/** Parser can be fixture-tested on Linux and Windows without COM hardware. */
export function parseWindowsSerialInventory(input: unknown): WindowsInventory {
  const obj = dict(input);
  if (!obj || obj.ok !== true || obj.source !== "Win32_PnPEntity+Win32_SerialPort" ||
      typeof obj.truncated !== "boolean" || !Array.isArray(obj.ports) || obj.ports.length > MAX_PORTS) {
    return failure("WINDOWS_SERIAL_SNAPSHOT_INVALID");
  }
  const ports: WindowsPort[] = [];
  const unique = new Set<string>();
  for (const entry of obj.ports) {
    const row = dict(entry);
    if (!row || typeof row.device !== "string" || !/^COM[1-9][0-9]{0,3}$/.test(row.device) ||
        unique.has(row.device)) return failure("WINDOWS_SERIAL_SNAPSHOT_INVALID");
    if (row.transport !== "usb" && row.transport !== "bluetooth" && row.transport !== "unknown") return failure("WINDOWS_SERIAL_SNAPSHOT_INVALID");
    const vid = row.vid === null ? null : row.vid;
    const pid = row.pid === null ? null : row.pid;
    if ((vid !== null && (typeof vid !== "string" || !/^[0-9A-F]{4}$/.test(vid))) ||
        (pid !== null && (typeof pid !== "string" || !/^[0-9A-F]{4}$/.test(pid))) ||
        (vid === null) !== (pid === null)) return failure("WINDOWS_SERIAL_SNAPSHOT_INVALID");
    const fields = ["friendlyName", "manufacturer", "status"] as const;
    for (const key of fields) {
      if (row[key] !== null && safeText(row[key]) === null) return failure("WINDOWS_SERIAL_SNAPSHOT_INVALID");
    }
    unique.add(row.device);
    ports.push({
      device: row.device, driver: null, sysfsPath: null,
      friendlyName: safeText(row.friendlyName), manufacturer: safeText(row.manufacturer),
      transport: row.transport, vid: vid as string | null, pid: pid as string | null,
      status: safeText(row.status),
    });
  }
  return {
    ok: true, platform: "win32", source: obj.source, truncated: obj.truncated, ports,
  };
}

export async function inspectWindowsSerialPorts(): Promise<WindowsInventory> {
  if (process.platform !== "win32") return failure("WINDOWS_ONLY");
  return new Promise<WindowsInventory>((resolve) => {
    let finished = false;
    let bytes = 0;
    let stdout = "";
    const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-File", SCRIPT], {
      shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    });
    const done = (result: WindowsInventory) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(failure("WINDOWS_SERIAL_SNAPSHOT_TIMEOUT"));
    }, TIMEOUT_MS);
    child.on("error", () => done(failure("WINDOWS_POWERSHELL_UNAVAILABLE")));
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) {
        child.kill("SIGKILL");
        done(failure("WINDOWS_SERIAL_OUTPUT_TOO_LARGE"));
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      if (finished) return;
      if (code !== 0) return done(failure("WINDOWS_SERIAL_SNAPSHOT_FAILED"));
      try {
        const input: unknown = JSON.parse(stdout);
        const obj = dict(input);
        if (obj?.ok === false) return done(failure("WINDOWS_SERIAL_SNAPSHOT_UNAVAILABLE"));
        done(parseWindowsSerialInventory(input));
      } catch {
        done(failure("WINDOWS_SERIAL_SNAPSHOT_INVALID"));
      }
    });
  });
}
