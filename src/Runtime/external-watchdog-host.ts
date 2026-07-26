import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type WatchdogModule = {
  startWatchdog: () => Promise<unknown> | unknown;
  stopWatchdog?: () => Promise<unknown> | unknown;
  getWatchdogStatus?: () => unknown;
};

type LoadedWatchdog = {
  name: string;
  manifestPath: string;
  module: WatchdogModule;
  startResult: unknown;
};

export type ExternalWatchdogHost = {
  loaded: LoadedWatchdog[];
  stop: () => Promise<void>;
};

export async function startExternalWatchdogHost(workspaceRoot: string): Promise<ExternalWatchdogHost> {
  const loaded: LoadedWatchdog[] = [];
  for (const manifestPath of discoverManifests(workspaceRoot)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        apiVersion?: number;
        name?: string;
        enabled?: boolean;
        entrypoint?: string;
      };
      if (manifest.enabled !== true || manifest.apiVersion !== 1 || !manifest.name || !manifest.entrypoint) {
        continue;
      }
      const entrypoint = path.resolve(path.dirname(manifestPath), manifest.entrypoint);
      const imported = await import(pathToFileURL(entrypoint).href) as WatchdogModule;
      if (typeof imported.startWatchdog !== "function") {
        throw new Error("entrypoint does not export startWatchdog()");
      }
      const startResult = await imported.startWatchdog();
      loaded.push({ name: manifest.name, manifestPath, module: imported, startResult });
      console.log("external-watchdog-host: " + manifest.name + " " + JSON.stringify(startResult));
    } catch (error) {
      console.error("external-watchdog-host: failed to load " + manifestPath + ": " + String(error));
    }
  }
  return {
    loaded,
    stop: async () => {
      await Promise.allSettled(loaded.map(async (item) => {
        if (typeof item.module.stopWatchdog === "function") {
          await item.module.stopWatchdog();
        }
      }));
    }
  };
}

function discoverManifests(workspaceRoot: string): string[] {
  try {
    return fs.readdirSync(workspaceRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(workspaceRoot, entry.name, "watchdog", "manifest.json"))
      .filter((manifestPath) => fs.existsSync(manifestPath))
      .sort();
  } catch (error) {
    console.error("external-watchdog-host: discovery failed: " + String(error));
    return [];
  }
}
