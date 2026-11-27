import {
  prepareChatPromptScreenshot, resolveChatPromptScreenshotBounds,
  inspectChatPromptScreenshotPng,
  type SharedMessageEvidence, type ScreenshotTheme,
} from "./chat-prompt-screenshot.js";

// Internal only. The Console supervisor must supply an admitted, exclusively
// leased disposable target and retain its CDP session until disposal.
// Neither a target ID nor a CDP endpoint is exposed to the MCP caller.
type ScreenshotSession = {
  verify: () => Promise<void>;
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  observeSharedMessage: (expectedUrl: string) => Promise<SharedMessageEvidence>;
  dispose: () => Promise<void>;
};

const MAX_ENCODED_BYTES = 12 * 1024 * 1024;
const MOBILE_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

export async function executeChatPromptScreenshot(
  url: string,
  acquire: () => Promise<ScreenshotSession>,
  now = new Date(),
  systemTheme?: ScreenshotTheme,
) {
  const plan = prepareChatPromptScreenshot(url, now, systemTheme);
  const session = await acquire();
  try {
    await session.verify();
    const { width, height, deviceScaleFactor, isMobile, hasTouch } = plan.device;
    await session.call("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor, mobile: isMobile,
      screenWidth: width, screenHeight: height,
    });
    await session.call("Emulation.setTouchEmulationEnabled", { enabled: hasTouch, maxTouchPoints: 5 });
    await session.call("Emulation.setUserAgentOverride", { userAgent: MOBILE_USER_AGENT, platform: "iPhone" });
    await session.call("Emulation.setEmulatedMedia", {
      media: "screen", features: [{ name: "prefers-color-scheme", value: plan.theme }],
    });
    const navigation = await session.call("Page.navigate", { url: plan.url }) as { errorText?: string } | undefined;
    if (!navigation || navigation.errorText) throw new Error("CHAT_PROMPT_SCREENSHOT_NAVIGATION_FAILED");
    const before = await session.observeSharedMessage(plan.url);
    const { captureBeyondViewport, ...clip } = resolveChatPromptScreenshotBounds(plan.url, before);
    await session.verify();
    const result = await session.call("Page.captureScreenshot", {
      format: "png", fromSurface: true, captureBeyondViewport, clip,
    }) as { data?: unknown } | undefined;
    const encoded = result?.data;
    if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > MAX_ENCODED_BYTES
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
      throw new Error("CHAT_PROMPT_SCREENSHOT_PAYLOAD_INVALID");
    }
    const png = Buffer.from(encoded, "base64");
    if (png.toString("base64") !== encoded) throw new Error("CHAT_PROMPT_SCREENSHOT_PAYLOAD_INVALID");
    const metadata = inspectChatPromptScreenshotPng(png, before.bounds);
    const after = await session.observeSharedMessage(plan.url);
    const afterClip = resolveChatPromptScreenshotBounds(plan.url, after);
    if (["x", "y", "width", "height"].some(key =>
      afterClip[key as "x" | "y" | "width" | "height"] !== clip[key as "x" | "y" | "width" | "height"])) {
      throw new Error("CHAT_PROMPT_SCREENSHOT_TARGET_CHANGED");
    }
    await session.verify();
    // No success or image delivery if target disposal fails.
    return { plan, metadata, png };
  } finally {
    await session.dispose();
  }
}
