import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const unescapeMountPath = (value: string): string => value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));

/** CDP file paths are interpreted by the browser, outside Console's systemd mount namespace. */
export async function resolveBrowserUploadPath(filePath: string, mountInfo?: string, platform = process.platform): Promise<string> {
  const absolutePath = path.resolve(filePath);
  if (platform !== "linux") return absolutePath;
  const info = mountInfo ?? await readFile("/proc/self/mountinfo", "utf8");
  const mounts = info.split("\n").filter(Boolean).map((line) => {
    const fields = line.split(" ");
    return { device: fields[2], root: unescapeMountPath(fields[3] ?? ""), mount: unescapeMountPath(fields[4] ?? "") };
  });
  const containing = mounts.filter((entry) => absolutePath === entry.mount || absolutePath.startsWith(entry.mount.replace(/\/$/, "") + "/"))
    .sort((a, b) => b.mount.length - a.mount.length)[0];
  if (!containing || containing.root === "/") return absolutePath;
  const filesystemRoot = mounts.find((entry) => entry.device === containing.device && entry.root === "/" && entry.mount === "/");
  if (!filesystemRoot) throw new Error("BROWSER_UPLOAD_SHARED_FILESYSTEM_NOT_FOUND");
  const sharedPath = path.join(containing.root, path.relative(containing.mount, absolutePath));
  const [original, shared] = await Promise.all([stat(absolutePath), stat(sharedPath)]);
  if (!original.isFile() || !shared.isFile() || original.dev !== shared.dev || original.ino !== shared.ino || original.size !== shared.size) {
    throw new Error("BROWSER_UPLOAD_SHARED_FILE_IDENTITY_MISMATCH");
  }
  return sharedPath;
}
