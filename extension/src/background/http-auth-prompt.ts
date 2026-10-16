// The confirmation window for an HTTP auth challenge (issue #905, C4 rule 7).
// It decides only whether the extension releases a credential; Chrome's own
// dialog is what the user gets on every outcome other than "send".
//
// A prompt is identified by an unguessable id carried in the window URL. Only
// the window's own page knows it, so a decision for an unknown, settled or stale
// id is ignored, and a second decision for one prompt is dropped.

import type { HttpAuthDecision, HttpAuthPromptView } from "../types/messages";
import { MS_PER_SECOND } from "../lib/time";
import { classifyError, warnBackground } from "./log";

export const PROMPT_PAGE = "src/auth-prompt/index.html";
export const PROMPT_TIMEOUT_MS = 60 * MS_PER_SECOND;
const WINDOW_WIDTH = 440;
const WINDOW_HEIGHT = 420;
// Below the target window's toolbar, so the prompt reads as belonging to it.
const WINDOW_TOP_OFFSET = 80;

export type PromptRequest = HttpAuthPromptView & {
  /** The challenged request; its webRequest error settles the prompt. */
  requestId: string;
  tabId: number;
};

type Prompt = {
  id: string;
  key: string;
  view: HttpAuthPromptView;
  tabId: number;
  requestIds: Set<string>;
  windowId: number | null;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
  decision: Promise<HttpAuthDecision>;
  resolve: (decision: HttpAuthDecision) => void;
};

const promptsById = new Map<string, Prompt>();
// One prompt per (origin, tab): concurrent challenges for the same navigation
// share a window, and each challenge gets the shared decision as its answer.
const promptsByKey = new Map<string, Prompt>();

function settle(prompt: Prompt, decision: HttpAuthDecision): void {
  if (prompt.settled) return;
  prompt.settled = true;
  clearTimeout(prompt.timer);
  promptsById.delete(prompt.id);
  if (promptsByKey.get(prompt.key) === prompt) promptsByKey.delete(prompt.key);
  prompt.resolve(decision);
  if (prompt.windowId !== null) closeWindow(prompt.windowId);
}

function closeWindow(windowId: number): void {
  try {
    chrome.windows.remove(windowId).catch(() => {
      // Already closed by the user or by the page itself.
    });
  } catch {
    // Same: the window is gone.
  }
}

async function placement(tabId: number): Promise<{ left?: number; top?: number }> {
  try {
    const tab = await chrome.tabs.get(tabId);
    const win = await chrome.windows.get(tab.windowId);
    if (win.left === undefined || win.width === undefined) return {};
    return {
      left: Math.max(0, Math.round(win.left + (win.width - WINDOW_WIDTH) / 2)),
      top: (win.top ?? 0) + WINDOW_TOP_OFFSET,
    };
  } catch {
    // No position: Chrome places the window itself.
    return {};
  }
}

async function showWindow(prompt: Prompt): Promise<void> {
  try {
    const created = await chrome.windows.create({
      url: chrome.runtime.getURL(`${PROMPT_PAGE}?id=${encodeURIComponent(prompt.id)}`),
      type: "popup",
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      focused: true,
      ...(await placement(prompt.tabId)),
    });
    const windowId = created?.id ?? null;
    if (prompt.settled) {
      // Settled (timeout, tab closed, request failed) while the window opened.
      if (windowId !== null) closeWindow(windowId);
      return;
    }
    if (windowId === null) {
      settle(prompt, "cancel");
      return;
    }
    prompt.windowId = windowId;
  } catch (err) {
    warnBackground("http-auth-prompt-failed", classifyError(err));
    settle(prompt, "cancel");
  }
}

/**
 * Ask the user whether to send the bound login for this challenge. Resolves
 * "send" only on the window's Send button; Cancel, closing the window, the
 * 60 s timeout, the tab closing, the request failing and any error resolve
 * "cancel". Never rejects.
 */
export function openPrompt(req: PromptRequest): Promise<HttpAuthDecision> {
  const key = `${req.origin}\n${req.tabId}`;
  const shared = promptsByKey.get(key);
  if (shared && !shared.settled) {
    shared.requestIds.add(req.requestId);
    return shared.decision;
  }
  let resolve!: (decision: HttpAuthDecision) => void;
  const decision = new Promise<HttpAuthDecision>((r) => {
    resolve = r;
  });
  const { requestId, tabId, ...view } = req;
  const prompt: Prompt = {
    id: crypto.randomUUID(),
    key,
    view,
    tabId,
    requestIds: new Set([requestId]),
    windowId: null,
    timer: setTimeout(() => settle(prompt, "cancel"), PROMPT_TIMEOUT_MS),
    settled: false,
    decision,
    resolve,
  };
  promptsById.set(prompt.id, prompt);
  promptsByKey.set(key, prompt);
  void showWindow(prompt);
  return decision;
}

/** What the window for `promptId` shows, or null for an unknown or settled id. */
export function getPromptView(promptId: unknown): HttpAuthPromptView | null {
  if (typeof promptId !== "string") return null;
  return promptsById.get(promptId)?.view ?? null;
}

/** Settle a pending prompt from its window. False when nothing was settled. */
export function decidePrompt(promptId: unknown, decision: unknown): boolean {
  if (typeof promptId !== "string") return false;
  if (decision !== "send" && decision !== "cancel") return false;
  const prompt = promptsById.get(promptId);
  if (!prompt) return false;
  settle(prompt, decision);
  return true;
}

export function handlePromptWindowRemoved(windowId: number): void {
  for (const prompt of [...promptsById.values()]) {
    if (prompt.windowId === windowId) settle(prompt, "cancel");
  }
}

export function handlePromptTabRemoved(tabId: number): void {
  for (const prompt of [...promptsById.values()]) {
    if (prompt.tabId === tabId) settle(prompt, "cancel");
  }
}

export function handlePromptRequestError(requestId: string): void {
  for (const prompt of [...promptsById.values()]) {
    if (prompt.requestIds.has(requestId)) settle(prompt, "cancel");
  }
}

/** Cancel every pending prompt and forget them (SW start, tests). */
export function resetHttpAuthPrompts(): void {
  for (const prompt of [...promptsById.values()]) settle(prompt, "cancel");
  promptsById.clear();
  promptsByKey.clear();
}

const onWindowRemoved = (windowId: number): void => handlePromptWindowRemoved(windowId);
const onTabRemoved = (tabId: number): void => handlePromptTabRemoved(tabId);

/**
 * Close-to-cancel wiring. Guarded and idempotent: a mock or a browser without
 * chrome.windows leaves prompts to their timeout instead of failing SW start.
 */
export function registerPromptListeners(): void {
  for (const [event, listener] of [
    [chrome.windows?.onRemoved, onWindowRemoved],
    [chrome.tabs?.onRemoved, onTabRemoved],
  ] as const) {
    try {
      if (!event) continue;
      if (typeof event.hasListener === "function" && event.hasListener(listener)) continue;
      event.addListener(listener);
    } catch (err) {
      warnBackground("http-auth-listener-register-failed", classifyError(err));
    }
  }
}
