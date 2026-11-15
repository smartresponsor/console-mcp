/**
 * Passive physical-port inventory for the Network MCP.
 *
 * No subprocesses, packets, credentials, serial port opens or device mutations.
 * Platform support is explicit: Linux sysfs + /dev, OS networkInterfaces fallback.
 */
import { networkInterfaces, platform } from "node:os";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

const MAX_INTERFACES = 64;
const MAX_SERIAL_PORTS = 64;
const IFACE_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const SERIAL_NAME = /^tty(?:USB|ACM)\d{1,4}$/;

type Address = {
  family: string;
  address: string;
  netmask: string;
  cidr: string | null;
  internal: boolean;
  mac: string;
};

type NetworkInterfaceInfo = {
  name: string;
  addresses: Address[];
  kind: "ethernet" | "wireless" | "virtual" | "unknown";
  operstate: string | null;
  carrier: boolean | null;
  mtu: number | null;
  speedMbps: number | null;
  duplex: string | null;
  driver: string | null;
  devicePath: string | null;
  rxErrors: number | null;
  txErrors: number | null;
  rxDropped: number | null;
  txDropped: number | null;
};

async function readSysfs(name: string, relative: string): Promise<string | null> {
  if (!IFACE_NAME.test(name)) return null;
  try {
    return (await readFile(path.join("/sys/class/net", name, relative), "utf8")).trim();
  } catch {
    return null;
  }
}

function boundedInteger(raw: string | null): number | null {
  if (raw === null || !/^\d{1,16}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

async function mappedDriver(name: string): Promise<string | null> {
  if (!IFACE_NAME.test(name)) return null;
  try {
    return path.basename(await realpath(path.join("/sys/class/net", name, "device/driver")));
  } catch {
    return null;
  }
}

async function mappedDevice(name: string): Promise<string | null> {
  if (!IFACE_NAME.test(name)) return null;
  try {
    const location = await realpath(path.join("/sys/class/net", name, "device"));
    return location.startsWith("/sys/devices/") ? location : null;
  } catch {
    return null;
  }
}

export async function inspectHostNetworkInterfaces(): Promise<{
  ok: true;
  platform: string;
  source: string;
  truncated: boolean;
  interfaces: NetworkInterfaceInfo[];
}> {
  const osName = platform();
  const raw = networkInterfaces();
  const names = Object.keys(raw).filter((name) => IFACE_NAME.test(name)).sort();
  const interfaces: NetworkInterfaceInfo[] = [];
  for (const name of names.slice(0, MAX_INTERFACES)) {
    const addresses = (raw[name] ?? []).slice(0, 16).map((address) => ({
      family: String(address.family),
      address: address.address,
      netmask: address.netmask,
      cidr: address.cidr ?? null,
      internal: address.internal,
      mac: address.mac,
    }));
    const linux = osName === "linux";
    const [operstate, carrier, mtu, speed, duplex, wireless, driver, devicePath, rxErrors, txErrors, rxDropped, txDropped] = linux
      ? await Promise.all([
        readSysfs(name, "operstate"), readSysfs(name, "carrier"), readSysfs(name, "mtu"),
        readSysfs(name, "speed"), readSysfs(name, "duplex"),
        readSysfs(name, "wireless"), mappedDriver(name), mappedDevice(name),
        readSysfs(name, "statistics/rx_errors"), readSysfs(name, "statistics/tx_errors"),
        readSysfs(name, "statistics/rx_dropped"), readSysfs(name, "statistics/tx_dropped"),
      ])
      : [null, null, null, null, null, null, null, null, null, null, null, null];

    const isLoopback = addresses.length > 0 && addresses.every((address) => address.internal);
    const kind: NetworkInterfaceInfo["kind"] = isLoopback || name.startsWith("veth") || name.startsWith("docker") || name.startsWith("br-")
      ? "virtual"
      : wireless !== null || /^wl/.test(name)
        ? "wireless"
        : /^en|^eth|^usb/.test(name)
          ? "ethernet"
          : "unknown";
    const measuredSpeed = Number(speed);
    interfaces.push({
      name, addresses, kind,
      operstate,
      carrier: carrier === "1" ? true : carrier === "0" ? false : null,
      mtu: boundedInteger(mtu),
      speedMbps: speed !== null && Number.isInteger(measuredSpeed) && measuredSpeed > 0 && measuredSpeed <= 1_000_000 ? measuredSpeed : null,
      duplex: duplex === "full" || duplex === "half" ? duplex : null,
      driver, devicePath,
      rxErrors: boundedInteger(rxErrors), txErrors: boundedInteger(txErrors),
      rxDropped: boundedInteger(rxDropped), txDropped: boundedInteger(txDropped),
    });
  }
  return { ok: true, platform: osName, source: osName === "linux" ? "os.networkInterfaces+sysfs" : "os.networkInterfaces",
    truncated: names.length > MAX_INTERFACES, interfaces };
}

export async function inspectLocalSerialPorts(): Promise<{
  ok: boolean;
  platform: string;
  source: string;
  reason?: string;
  truncated: boolean;
  ports: Array<{ device: string; driver: string | null; sysfsPath: string | null }>;
}> {
  const osName = platform();
  if (osName !== "linux") return {
    ok: false, platform: osName, source: "unsupported", reason: "SERIAL_ENUMERATION_UNSUPPORTED_ON_PLATFORM",
    truncated: false, ports: [],
  };
  let all: string[];
  try {
    all = (await readdir("/dev")).filter((name) => SERIAL_NAME.test(name)).sort();
  } catch {
    return { ok: false, platform: osName, source: "/dev", reason: "SERIAL_DEVICE_LIST_UNAVAILABLE", truncated: false, ports: [] };
  }
  const ports = await Promise.all(all.slice(0, MAX_SERIAL_PORTS).map(async (name) => {
    let sysfsPath: string | null = null;
    let driver: string | null = null;
    try {
      const target = await realpath(path.join("/sys/class/tty", name, "device"));
      if (target.startsWith("/sys/devices/")) sysfsPath = target;
    } catch { /* an unbound serial device has no stable device link */ }
    try {
      driver = path.basename(await realpath(path.join("/sys/class/tty", name, "device/driver")));
    } catch { /* driver path not available */ }
    return { device: "/dev/" + name, driver, sysfsPath };
  }));
  return { ok: true, platform: osName, source: "/dev+/sys/class/tty",
    truncated: all.length > MAX_SERIAL_PORTS, ports };
}
