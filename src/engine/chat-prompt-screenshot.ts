import { createHash } from "node:crypto";
import { crc32, inflateSync } from "node:zlib";

export const CHAT_PROMPT_SCREENSHOT_CAPABILITY = "write.engine.chat.prompt.screenshot";
export const CHAT_PROMPT_SCREENSHOT_PROFILE = Object.freeze({
  name: "iphone_15",
  width: 393,
  height: 852,
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});
export type ScreenshotTheme = "light" | "dark";

export function prepareChatPromptScreenshot(url: string, now = new Date(), systemTheme?: ScreenshotTheme) {
  if (!/^https:\/\/chatgpt\.com\/s\/t_[a-f0-9]{32}$/.test(url) || /\s/.test(url)) {
    throw new Error("CHAT_PROMPT_SCREENSHOT_URL_INVALID");
  }
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", hour: "2-digit", hourCycle: "h23",
  }).format(now));
  return {
    url,
    target: "shared_message" as const,
    device: CHAT_PROMPT_SCREENSHOT_PROFILE,
    theme: systemTheme ?? (hour >= 7 && hour < 19 ? "light" : "dark"),
    themeSource: systemTheme ? "system" : "local_time_fallback",
    format: "png" as const,
  };
}

export type SharedMessageEvidence = {
  url: string;
  ready: boolean;
  candidateCount: number;
  exactSharedMessage: boolean;
  bounds: { x: number; y: number; width: number; height: number };
};

// No last-message fallback: the supervisor must prove the exact shared block.
export function resolveChatPromptScreenshotBounds(expectedUrl: string, evidence: SharedMessageEvidence) {
  if (evidence.url !== expectedUrl || !evidence.ready
      || evidence.candidateCount !== 1 || !evidence.exactSharedMessage) {
    throw new Error("CHAT_PROMPT_SCREENSHOT_TARGET_UNVERIFIED");
  }
  const { x, y, width, height } = evidence.bounds;
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0
      || width <= 0 || height <= 0 || x + width > CHAT_PROMPT_SCREENSHOT_PROFILE.width) {
    throw new Error("CHAT_PROMPT_SCREENSHOT_BOUNDS_INVALID");
  }
  const scale = CHAT_PROMPT_SCREENSHOT_PROFILE.deviceScaleFactor;
  if (Math.ceil(height * scale) > 32000 || Math.ceil(width * scale) * Math.ceil(height * scale) > 40000000) {
    throw new Error("CHAT_PROMPT_SCREENSHOT_SIZE_LIMIT");
  }
  return { x, y, width, height, scale: 1, captureBeyondViewport: true };
}

// Validate the non-interlaced 8-bit RGB/RGBA PNG subset emitted by Chromium.
export function inspectChatPromptScreenshotPng(png: Buffer, bounds: SharedMessageEvidence["bounds"]) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (png.length < 33 || !png.subarray(0, 8).equals(signature)
      || png.readUInt32BE(8) !== 13 || png.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("CHAT_PROMPT_SCREENSHOT_PNG_INVALID");
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const scale = CHAT_PROMPT_SCREENSHOT_PROFILE.deviceScaleFactor;
  if (width <= 0 || height <= 0 || Math.abs(width - bounds.width * scale) > 1
      || Math.abs(height - bounds.height * scale) > 1) {
    throw new Error("CHAT_PROMPT_SCREENSHOT_DIMENSIONS_MISMATCH");
  }
  const invalid = () => { throw new Error("CHAT_PROMPT_SCREENSHOT_PNG_INVALID"); };
  if (png.length > 9 * 1024 * 1024 || width > 1179 || height > 32000 || width * height > 40000000) invalid();
  const colorType = png[25];
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (png[24] !== 8 || !channels || png[26] !== 0 || png[27] !== 0 || png[28] !== 0) invalid();
  const chunks: Buffer[] = [];
  let offset = 8, ended = false, dataEnded = false, count = 0;
  while (offset < png.length) {
    if (++count > 16384 || offset + 12 > png.length) invalid();
    const size = png.readUInt32BE(offset);
    const end = offset + 12 + size;
    if (end > png.length) invalid();
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(png.subarray(offset + 4, end - 4)) !== png.readUInt32BE(end - 4)) invalid();
    if (type === "IHDR") {
      if (offset !== 8 || size !== 13) invalid();
    } else if (type === "IDAT") {
      if (dataEnded) invalid();
      chunks.push(png.subarray(offset + 8, end - 4));
    } else if (type === "IEND") {
      if (size !== 0 || !chunks.length || end !== png.length) invalid();
      ended = true;
    } else {
      // No unknown critical chunks or alternate animated frames.
      if (/^[A-Z]/.test(type) || ["acTL", "fcTL", "fdAT"].includes(type)) invalid();
      if (chunks.length) dataEnded = true;
    }
    offset = end;
  }
  if (!ended) invalid();
  const rowBytes = 1 + width * channels;
  const expectedBytes = rowBytes * height;
  let decoded: Buffer;
  try {
    const compressed = Buffer.concat(chunks);
    // Node returns {buffer, engine} for info:true; the installed declaration lacks that overload.
    const result = inflateSync(compressed, { maxOutputLength: expectedBytes, info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (!Buffer.isBuffer(result.buffer) || !result.engine) invalid();
    decoded = result.buffer;
    if (result.engine.bytesWritten !== compressed.length) invalid();
  } catch { throw new Error("CHAT_PROMPT_SCREENSHOT_PNG_INVALID"); }
  if (decoded.length !== expectedBytes) invalid();
  for (let row = 0; row < height; row++) if (decoded[row * rowBytes] > 4) invalid();
  return { mimeType: "image/png", width, height, sha256: createHash("sha256").update(png).digest("hex") };
}
