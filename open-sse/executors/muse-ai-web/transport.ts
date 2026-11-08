import { setTimeout as delay } from "node:timers/promises";
import type { Browser, BrowserContext, Page } from "playwright-core";

import { loadPlaywrightCore } from "../../utils/optionalPlaywrightCore.ts";

import { readMuseSnapshot, type MuseSnapshot } from "./markdown.ts";

export const MUSE_AI_CHAT_URL = "https://muse.ai/thread/new";
const MUSE_AI_ORIGIN = new URL(MUSE_AI_CHAT_URL).origin;
const COMPOSER_SELECTOR = "textarea:visible";
const SEND_SELECTOR =
  '[data-testid="hatch-composer-send-button"]:visible, ' +
  'button[aria-label^="Send" i]:visible, [role="button"][aria-label^="Send" i]:visible';
const REQUEST_TIMEOUT_MS = 180_000;
const FIRST_REPLY_TIMEOUT_MS = 40_000;
const REPLY_QUIET_MS = 4_800;

export type MuseAiTransport = (options: {
  cookieHeader: string;
  prompt: string;
  signal?: AbortSignal | null;
  repairPrompt?: (reply: string) => string | undefined;
}) => Promise<string>;

export class MuseAiTransportError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "MuseAiTransportError";
  }
}

function parseCookies(header: string): Parameters<BrowserContext["addCookies"]>[0] {
  const cookies = new Map<string, string>();
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (/^[\w!#$%&'*+.^|~-]+$/.test(name) && value && /^[\x21-\x7E]+$/.test(value)) {
      cookies.set(name, value);
    }
  }
  if (!cookies.has("hatch_sess")) {
    throw new MuseAiTransportError(401, "Muse requires a hatch_sess session cookie.");
  }
  return Array.from(cookies, ([name, value]) => ({
    name,
    value,
    url: MUSE_AI_ORIGIN + "/",
    httpOnly: name === "hatch_sess",
  }));
}

async function launchBrowser(): Promise<Browser> {
  const { chromium } = await loadPlaywrightCore();
  const options = { headless: true, timeout: 15_000 };
  try {
    if (process.platform === "win32") {
      return await chromium.launch({ ...options, channel: "chrome" });
    }
    return await chromium.launch(options);
  } catch {
    if (process.platform === "win32") {
      try {
        return await chromium.launch(options);
      } catch {
        // Báo lỗi chung để tránh đưa đường dẫn hoặc tham số tiến trình ra ngoài.
      }
    }
    throw new MuseAiTransportError(502, "Muse requires Google Chrome or Playwright Chromium.");
  }
}

async function openComposer(page: Page): Promise<void> {
  const response = await page.goto(MUSE_AI_CHAT_URL, {
    waitUntil: "domcontentloaded",
    timeout: 40_000,
  });
  const status = response?.status();
  if (status === 401 || status === 403 || status === 429) {
    throw new MuseAiTransportError(status, "Muse rejected the browser session.");
  }
  if (new URL(page.url()).origin !== MUSE_AI_ORIGIN) {
    throw new MuseAiTransportError(401, "The Muse session redirected to sign-in.");
  }
  await page.waitForFunction(
    () => {
      const input = document.querySelector<HTMLTextAreaElement>("textarea");
      const shell = document.querySelector("[data-hatch-shell-hydration-state]");
      return (
        document.readyState === "complete" &&
        input &&
        !input.disabled &&
        (!shell || shell.getAttribute("data-hatch-shell-hydration-state") === "hydrated") &&
        !document.body.innerText.includes("Connecting...")
      );
    },
    undefined,
    { timeout: 40_000 }
  );
}

async function submitPrompt(page: Page, prompt: string): Promise<void> {
  const input = page.locator(COMPOSER_SELECTOR).first();
  await input.fill(prompt, { timeout: 12_000 });
  const send = page.locator(SEND_SELECTOR).first();
  try {
    await send.waitFor({ state: "visible", timeout: 3_000 });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    await input.press("Enter", { timeout: 5_000 });
    return;
  }
  await send.click({ timeout: 10_000 });
}

async function waitForReply(
  page: Page,
  baseline: MuseSnapshot,
  signal: AbortSignal
): Promise<string> {
  const firstReplyDeadline = performance.now() + FIRST_REPLY_TIMEOUT_MS;
  let current = "";
  let quietSince: number | undefined;
  for (;;) {
    signal.throwIfAborted();
    const snapshot = await page.evaluate(readMuseSnapshot);
    const now = performance.now();
    const hasReply =
      snapshot.text.length > 0 &&
      (snapshot.count > baseline.count || snapshot.text !== baseline.text);
    if (!hasReply) {
      current = "";
      quietSince = undefined;
      if (now >= firstReplyDeadline) {
        throw new MuseAiTransportError(504, "Muse did not start a reply in time.");
      }
    } else {
      if (snapshot.generating || snapshot.text !== current) quietSince = undefined;
      current = snapshot.text;
      if (!snapshot.generating) {
        quietSince ??= now;
        if (now - quietSince >= REPLY_QUIET_MS) return current;
      }
    }
    await delay(150, undefined, { signal });
  }
}

export async function exchangeMuseAiReply(
  send: (prompt: string) => Promise<string>,
  prompt: string,
  repairPrompt?: (reply: string) => string | undefined
): Promise<string> {
  const reply = await send(prompt);
  const correction = repairPrompt?.(reply);
  return correction ? send(correction) : reply;
}

export const completeMuseAi: MuseAiTransport = async ({
  cookieHeader,
  prompt,
  signal,
  repairPrompt,
}) => {
  const cookies = parseCookies(cookieHeader);
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const operation = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  const abort = () => {
    void browser?.close().catch(() => {});
  };
  operation.addEventListener("abort", abort, { once: true });
  try {
    operation.throwIfAborted();
    browser = await launchBrowser();
    operation.throwIfAborted();
    context = await browser.newContext({ locale: "en-US" });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await openComposer(page);
    // Lượt sửa dùng lại trang và cuộc chat đang mở, với mốc phản hồi mới.
    return await exchangeMuseAiReply(
      async (message) => {
        operation.throwIfAborted();
        const baseline = await page.evaluate(readMuseSnapshot);
        await submitPrompt(page, message);
        return waitForReply(page, baseline, operation);
      },
      prompt,
      repairPrompt
    );
  } catch (error) {
    if (signal?.aborted) throw new MuseAiTransportError(499, "The Muse request was cancelled.");
    if (timeout.aborted || (error instanceof Error && error.name === "TimeoutError")) {
      throw new MuseAiTransportError(504, "The Muse browser operation timed out.");
    }
    if (error instanceof MuseAiTransportError) throw error;
    throw new MuseAiTransportError(502, "The Muse browser session failed.");
  } finally {
    operation.removeEventListener("abort", abort);
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
};
