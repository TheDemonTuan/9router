import { createHmac } from "node:crypto";
import type { Page } from "playwright-core";
import { CHATGPT_COMPOSER_SELECTOR, assertAuthenticatedChatGptPage, assertNewChatPage, detectChatGptAccountCapabilities } from "./chatgpt-session";
import type { ChatGptWebAccountCapabilities } from "./chatgpt-web-models";
import { ChatGptWebAdapterError } from "./adapters/chatgpt-web/adapter-error";

export interface BrowserLoginEvidence {
  accountFingerprint: string;
  checkedAt: string;
  capabilities: ChatGptWebAccountCapabilities;
}
async function sessionIdentity(page: Page): Promise<string> {
  if (new URL(page.url()).origin !== "https://chatgpt.com") {
    throw new ChatGptWebAdapterError("ChatGPT profile is not on the authenticated origin", {
      status: 409, errorType: "runtime_error", code: "login_required", retryable: false,
    });
  }
  const result = await page.evaluate(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch("/api/auth/session", { credentials: "same-origin", redirect: "error", signal: controller.signal });
      if (!response.ok || new URL(response.url).origin !== location.origin) return null;
      const session = await response.json();
      const user = session && typeof session === "object" ? session.user : undefined;
      const expires = typeof session?.expires === "string" ? Date.parse(session.expires) : NaN;
      if (!user || !Number.isFinite(expires) || expires <= Date.now()) return null;
      const id = typeof user.id === "string" ? user.id : typeof user.email === "string" ? user.email : undefined;
      return id?.trim() || null;
    } catch { return null; }
    finally { clearTimeout(timer); }
  });
  if (!result) throw new ChatGptWebAdapterError("ChatGPT profile requires sign-in", {
    status: 409, errorType: "runtime_error", code: "login_required", retryable: false,
  });
  return result;
}
export async function assertBrowserLoginSession(page: Page): Promise<void> {
  await sessionIdentity(page);
  await assertAuthenticatedChatGptPage(page);
}
export async function probeBrowserLoginSession(page: Page, salt: Uint8Array, useSavedChats: boolean): Promise<BrowserLoginEvidence> {
  const identity = await sessionIdentity(page);
  try {
    await page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true }).waitFor({ state: "visible", timeout: 30_000 });
    await assertAuthenticatedChatGptPage(page);
    await assertNewChatPage(page, useSavedChats);
    const capabilities = await detectChatGptAccountCapabilities(page);
    return { accountFingerprint: createHmac("sha256", salt).update(identity).digest("hex"), checkedAt: new Date().toISOString(), capabilities };
  } catch (cause) {
    if (cause instanceof ChatGptWebAdapterError) throw cause;
    throw new ChatGptWebAdapterError("ChatGPT verification could not inspect the chat interface. Open Browser, wait for the page to finish loading, then choose Finish Sign In again.", {
      status: 502, errorType: "runtime_error", code: "profile_probe_failed", retryable: false, cause,
    });
  }
}
