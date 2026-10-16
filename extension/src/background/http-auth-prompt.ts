// The confirmation window for an HTTP auth challenge (issue #905, C4 rule 7).
// It decides only whether the extension releases a credential; Chrome's own
// dialog is what the user gets on every outcome other than "send".
//
// A prompt is identified by an unguessable id carried in the window URL. Only
// the window's own page knows it, so a decision for an unknown, settled, stale
// or not-yet-shown id is ignored, and a second decision for one prompt is
// dropped.
//
// One window at a time, globally: further prompts wait in a FIFO queue, so a
// page cannot stack windows to get a click on one it slid under the pointer.
// Each prompt's 60 s timeout starts when it is created (shown or queued), so a
// queued challenge still ends within 60 s, as {} if it was never decided.

import type { HttpAuthDecision, HttpAuthPromptView } from "../types/messages";
import { HTTP_AUTH_PROMPT_PAGE, HTTP_AUTH_PROMPT_TIMEOUT_MS } from "../lib/constants";
import { MS_PER_SECOND } from "../lib/time";
import { classifyError, warnBackground } from "./log";

export const PROMPT_PAGE = HTTP_AUTH_PROMPT_PAGE;
export const PROMPT_TIMEOUT_MS = HTTP_AUTH_PROMPT_TIMEOUT_MS;
/**
 * After a cross-site-initiated prompt ends without Send, further challenges for
 * that origin get {} without a window for this long, so a page cannot keep
 * re-raising the window until a click lands.
 */
export const PROMPT_COOLDOWN_MS = 10 * MS_PER_SECOND;
const WINDOW_WIDTH = 440;
const WINDOW_HEIGHT = 460;
// Below the target window's toolbar, so the prompt reads as belonging to it.
const WINDOW_TOP_OFFSET = 80;

export type PromptRequest = HttpAuthPromptView & {
  /** The challenged request; its webRequest error ends its part in the prompt. */
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
// One prompt per (origin, tab): a concurrent challenge for the same
// navigation (same url, initiator and scheme) shares its decision.
const promptsByKey = new Map<string, Prompt>();
// The prompt whose window is up, and the ones waiting for it to end.
let shown: Prompt | null = null;
const queue: Prompt[] = [];
// origin → time until which challenges get {} without a window.
const cooldownUntil = new Map<string, number>();

function isCrossSiteInitiated(view: HttpAuthPromptView): boolean {
  return view.initiator !== null && view.initiator !== view.origin;
}

function settle(prompt: Prompt, decision: HttpAuthDecision): void {
  if (prompt.settled) return;
  prompt.settled = true;
  clearTimeout(prompt.timer);
  promptsById.delete(prompt.id);
  if (promptsByKey.get(prompt.key) === prompt) promptsByKey.delete(prompt.key);
  const queued = queue.indexOf(prompt);
  if (queued !== -1) queue.splice(queued, 1);
  if (decision !== "send" && isCrossSiteInitiated(prompt.view)) {
    cooldownUntil.set(prompt.view.origin, Date.now() + PROMPT_COOLDOWN_MS);
  }
  prompt.resolve(decision);
  if (prompt.windowId !== null) closeWindow(prompt.windowId);
  if (shown === prompt) {
    shown = null;
    showNext();
  }
}

function showNext(): void {
  if (shown) return;
  const next = queue.shift();
  if (!next) return;
  shown = next;
  void showWindow(next);
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
    // Not clamped: a window on a display left of or above the primary one has
    // negative coordinates.
    return {
      left: Math.round(win.left + (win.width - WINDOW_WIDTH) / 2),
      top: (win.top ?? 0) + WINDOW_TOP_OFFSET,
    };
  } catch {
    // No position: Chrome places the window itself.
    return {};
  }
}

async function createWindow(prompt: Prompt): Promise<number | null> {
  const params: chrome.windows.CreateData = {
    url: chrome.runtime.getURL(`${PROMPT_PAGE}?id=${encodeURIComponent(prompt.id)}`),
    type: "popup",
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    focused: true,
  };
  const position = await placement(prompt.tabId);
  try {
    return (await chrome.windows.create({ ...params, ...position }))?.id ?? null;
  } catch (err) {
    // A position Chrome refuses (a display that went away) is retried once
    // unplaced; any other failure fails the same way again.
    if (position.left === undefined && position.top === undefined) throw err;
    return (await chrome.windows.create(params))?.id ?? null;
  }
}

async function showWindow(prompt: Prompt): Promise<void> {
  try {
    const windowId = await createWindow(prompt);
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

const sameChallenge = (a: HttpAuthPromptView, b: HttpAuthPromptView): boolean =>
  a.url === b.url && a.initiator === b.initiator && a.scheme === b.scheme;

/**
 * Ask the user whether to send the bound login for this challenge. Resolves
 * "send" only on the window's Send button; Cancel, closing the window, the
 * 60 s timeout, the tab closing, the request failing, a cooldown, a
 * conflicting concurrent challenge and any error resolve "cancel". Never
 * rejects.
 */
export function openPrompt(req: PromptRequest): Promise<HttpAuthDecision> {
  const { requestId, tabId, ...view } = req;
  if ((cooldownUntil.get(view.origin) ?? 0) > Date.now()) return Promise.resolve("cancel");
  const key = `${view.origin}\n${tabId}`;
  const existing = promptsByKey.get(key);
  if (existing && !existing.settled) {
    // Another challenge for the same origin and tab: it shares the window only
    // when it is the same navigation; anything else does not reuse a decision
    // the user made for something they were not shown.
    if (!sameChallenge(existing.view, view)) return Promise.resolve("cancel");
    existing.requestIds.add(requestId);
    return existing.decision;
  }
  let resolve!: (decision: HttpAuthDecision) => void;
  const decision = new Promise<HttpAuthDecision>((r) => {
    resolve = r;
  });
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
  queue.push(prompt);
  showNext();
  return decision;
}

/** What the window for `promptId` shows, or null for an unknown, settled or queued id. */
export function getPromptView(promptId: unknown): HttpAuthPromptView | null {
  if (typeof promptId !== "string") return null;
  const prompt = promptsById.get(promptId);
  return prompt && prompt === shown ? prompt.view : null;
}

/** Settle the shown prompt from its window. False when nothing was settled. */
export function decidePrompt(promptId: unknown, decision: unknown): boolean {
  if (typeof promptId !== "string") return false;
  if (decision !== "send" && decision !== "cancel") return false;
  const prompt = promptsById.get(promptId);
  if (!prompt || prompt !== shown) return false;
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

/**
 * A challenged request failed (navigated away, aborted). It no longer needs an
 * answer; the prompt ends only when none of its requests remains.
 */
export function handlePromptRequestError(requestId: string): void {
  for (const prompt of [...promptsById.values()]) {
    if (!prompt.requestIds.delete(requestId)) continue;
    if (prompt.requestIds.size === 0) settle(prompt, "cancel");
  }
}

/**
 * Cancel every pending prompt, close its window and forget it, cooldowns
 * included. Called when the vault locks (clearVault): a window must not keep
 * showing, or serving, an entry of a vault that is gone.
 */
export function resetHttpAuthPrompts(): void {
  queue.length = 0;
  shown = null;
  for (const prompt of [...promptsById.values()]) settle(prompt, "cancel");
  promptsById.clear();
  promptsByKey.clear();
  cooldownUntil.clear();
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
