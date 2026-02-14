// Pure logic module for form detection (exported, testable).
// Side-effect-free — no global event registration here.

// Navigation API — not yet in all TypeScript lib types
declare const navigation: EventTarget | undefined;

import type { DecryptedEntry } from "../types/messages";
import type { AutofillTargetHint } from "../types/messages";
import { t } from "../lib/i18n";
import {
  showDropdown,
  hideDropdown,
  isDropdownVisible,
  handleDropdownKeydown,
} from "./ui/suggestion-dropdown";
import { getShadowHost, removeShadowHost } from "./ui/shadow-host";

/** Returns false when the extension has been reloaded/updated and this content script is orphaned. */
function isContextValid(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

// ── Form field detection ────────────────────────────────────

const trackedInputs = new WeakSet<HTMLInputElement>();

export function isUsableInput(input: HTMLInputElement): boolean {
  return !input.disabled && !input.readOnly;
}

function resolveOpacity(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 1;
}

export function isElementVisuallySafe(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  // Block only near-invisible elements to reduce false positives on heavily styled forms.
  if (resolveOpacity(style.opacity) <= 0.05) return false;
  const clipPath = (style.clipPath || "").toLowerCase();
  if (clipPath.includes("inset(100%") || clipPath.includes("circle(0")) return false;
  const transform = (style.transform || "").toLowerCase();
  if (transform.includes("scale(0")) return false;
  return true;
}

export function isPageVisuallySafe(): boolean {
  const htmlStyle = getComputedStyle(document.documentElement);
  const bodyStyle = getComputedStyle(document.body);
  if (
    htmlStyle.display === "none" ||
    htmlStyle.visibility === "hidden" ||
    bodyStyle.display === "none" ||
    bodyStyle.visibility === "hidden"
  ) {
    return false;
  }
  // Guard against full-page transparency attacks while allowing subtle UI opacity effects.
  return resolveOpacity(htmlStyle.opacity) > 0.05 && resolveOpacity(bodyStyle.opacity) > 0.05;
}

export function isInputHitTestSafe(input: HTMLInputElement): boolean {
  const rect = input.getBoundingClientRect();
  // In layout-less environments (e.g., jsdom), skip hit-test gating.
  if (rect.width < 1 || rect.height < 1) return true;
  if (typeof document.elementFromPoint !== "function") return true;
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const top = document.elementFromPoint(x, y);
  if (!top) return true;
  if (top === input || input.contains(top) || (top instanceof HTMLElement && top.contains(input))) {
    return true;
  }
  const nearestLabel = input.closest("label");
  if (nearestLabel && nearestLabel.contains(top)) return true;
  return false;
}

function getOpenPopovers(): HTMLElement[] {
  const legacy = Array.from(
    document.querySelectorAll<HTMLElement>('[popover][open]'),
  );
  let openByPseudo: HTMLElement[] = [];
  try {
    openByPseudo = Array.from(
      document.querySelectorAll<HTMLElement>(':popover-open'),
    );
  } catch {
    // Selector unsupported in this runtime.
  }
  const uniq = new Set<HTMLElement>([...legacy, ...openByPseudo]);
  return Array.from(uniq);
}

export function hasVisiblePopoverOverlayNear(input: HTMLInputElement): boolean {
  const rect = input.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;

  for (const popover of getOpenPopovers()) {
    const style = getComputedStyle(popover);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      resolveOpacity(style.opacity) < 0.98 ||
      style.pointerEvents === "none"
    ) {
      continue;
    }
    const pRect = popover.getBoundingClientRect();
    if (pRect.width < 1 || pRect.height < 1) continue;
    const overlapsCenter =
      centerX >= pRect.left &&
      centerX <= pRect.right &&
      centerY >= pRect.top &&
      centerY <= pRect.bottom;
    if (overlapsCenter) return true;
  }

  return false;
}

export function findPasswordInputs(root: ParentNode): HTMLInputElement[] {
  return Array.from(root.querySelectorAll<HTMLInputElement>('input[type="password"]')).filter(
    isUsableInput,
  );
}

export function findUsernameInput(
  passwordInput: HTMLInputElement,
): HTMLInputElement | null {
  const form = passwordInput.closest("form");
  const scope: ParentNode = form ?? document;
  const inputs = Array.from(scope.querySelectorAll<HTMLInputElement>("input"));

  // Priority 1: autocomplete="username"
  const byAutocomplete = inputs.find(
    (i) =>
      isUsableInput(i) &&
      (i.type === "text" || i.type === "email") &&
      i.autocomplete === "username",
  );
  if (byAutocomplete) return byAutocomplete;

  // Priority 2: nearest preceding text/email input
  const pwIndex = inputs.indexOf(passwordInput);
  if (pwIndex <= 0) return null;
  for (let i = pwIndex - 1; i >= 0; i--) {
    const c = inputs[i];
    if (isUsableInput(c) && (c.type === "text" || c.type === "email")) {
      return c;
    }
  }
  return null;
}

const USERNAME_HINT_RE =
  /\b(user(name)?|login|email|e-?mail|identifier|account|member|contract|customer)\b/i;
const USERNAME_HINT_JA_RE =
  /(ログイン|ユーザー|メール|アカウント|会員|契約番号|ご契約番号|お客さま番号|顧客番号|店番|口座番号)/;
const NON_LOGIN_HINT_RE = /\b(search|query|keyword|coupon|promo|otp|code|verification)\b/i;
const NON_LOGIN_HINT_JA_RE = /(検索|クーポン|認証コード|確認コード|ワンタイム)/;

function escapeSelectorValue(value: string): string {
  // jsdom in tests may not implement CSS.escape.
  const esc = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS?.escape;
  if (esc) return esc(value);
  return value.replace(/["\\]/g, "\\$&");
}

export function isLikelyUsernameInput(input: HTMLInputElement): boolean {
  if (!isUsableInput(input)) return false;
  if (input.type === "password") return false;

  const type = (input.type || "text").toLowerCase();
  if (!["text", "email", "tel"].includes(type)) return false;

  const autocomplete = (input.autocomplete || "").toLowerCase().trim();
  if (autocomplete === "username") return true;
  if (autocomplete === "email") return true;
  if (
    autocomplete.includes("one-time-code") ||
    autocomplete.includes("new-password") ||
    autocomplete.includes("current-password")
  ) {
    return false;
  }

  const hints = [
    input.name,
    input.id,
    input.placeholder,
    input.getAttribute("formcontrolname"),
    input.getAttribute("ng-reflect-name"),
    input.getAttribute("aria-label"),
    input.getAttribute("aria-labelledby"),
    input.getAttribute("data-testid"),
    input.getAttribute("data-test"),
    (input.closest("label")?.textContent ?? ""),
    (() => {
      const id = input.id;
      if (!id) return "";
      return document.querySelector(`label[for="${escapeSelectorValue(id)}"]`)?.textContent ?? "";
    })(),
  ]
    .filter((v): v is string => Boolean(v && v.trim()))
    .join(" ");

  if (!hints) return false;
  if (!USERNAME_HINT_RE.test(hints) && !USERNAME_HINT_JA_RE.test(hints)) return false;
  if (NON_LOGIN_HINT_RE.test(hints) || NON_LOGIN_HINT_JA_RE.test(hints)) return false;
  return true;
}

// ── Dropdown integration ────────────────────────────────────

interface DropdownContext {
  input: HTMLInputElement;
  entries: DecryptedEntry[];
  vaultLocked: boolean;
}

let currentContext: DropdownContext | null = null;
let noticeTimer: number | null = null;

function getMessages(): { locked: string; noMatches: string; header: string } {
  return {
    locked: t("contentScript.vaultLocked"),
    noMatches: t("contentScript.noMatches"),
    header: t("contentScript.logins"),
  };
}

function showForInput(
  input: HTMLInputElement,
  entries: DecryptedEntry[],
  vaultLocked: boolean,
  suppressInline: boolean,
): void {
  // Suppress inline UI on passwd-sso application pages.
  if (suppressInline) {
    hideDropdown();
    currentContext = null;
    return;
  }

  const rect = input.getBoundingClientRect();
  const msgs = getMessages();

  currentContext = { input, entries, vaultLocked };

  showDropdown({
    anchorRect: rect,
    entries,
    vaultLocked,
    onSelect: (entryId) => {
      if (isContextValid()) {
        const targetHint: AutofillTargetHint = {
          id: input.id || undefined,
          name: input.name || undefined,
          type: input.type || undefined,
          autocomplete: input.autocomplete || undefined,
        };
        chrome.runtime.sendMessage(
          { type: "AUTOFILL_FROM_CONTENT", entryId, targetHint },
          (response?: { ok?: boolean; error?: string }) => {
            if (!isContextValid()) return;
            if (chrome.runtime.lastError) {
              showInlineNotice(input, t("errors.autofillFailed"));
              return;
            }
            if (!response?.ok) {
              if (response?.error === "VAULT_LOCKED") {
                showInlineNotice(input, t("contentScript.vaultLocked"));
              } else if (response?.error === "NO_PASSWORD") {
                showInlineNotice(input, t("errors.noPassword"));
              } else {
                showInlineNotice(input, t("errors.autofillFailed"));
              }
              return;
            }
            hideDropdown();
          },
        );
      }
    },
    onDismiss: () => {
      currentContext = null;
    },
    lockedMessage: msgs.locked,
    noMatchesMessage: msgs.noMatches,
    headerLabel: msgs.header,
  });
}

function showInlineNotice(input: HTMLInputElement, message: string): void {
  const { root } = getShadowHost();
  const existing = root.querySelector(".psso-inline-notice");
  if (existing) existing.remove();

  const style = document.createElement("style");
  style.textContent = `
    .psso-inline-notice {
      position: fixed;
      z-index: 2147483647;
      background: #111827;
      color: #fff;
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 12px;
      line-height: 1.3;
      box-shadow: 0 8px 20px rgba(0,0,0,.25);
      max-width: min(360px, calc(100vw - 24px));
      pointer-events: none;
    }
  `;
  root.appendChild(style);

  const notice = document.createElement("div");
  notice.className = "psso-inline-notice";
  notice.textContent = message;
  root.appendChild(notice);

  const rect = input.getBoundingClientRect();
  notice.style.top = `${Math.max(8, rect.top - 40)}px`;
  notice.style.left = `${Math.max(8, rect.left)}px`;

  if (noticeTimer) {
    window.clearTimeout(noticeTimer);
  }
  noticeTimer = window.setTimeout(() => {
    notice.remove();
    style.remove();
    noticeTimer = null;
  }, 2200);
}

// ── Core initialization ─────────────────────────────────────

export interface FormDetectorCleanup {
  destroy: () => void;
}

export function initFormDetector(): FormDetectorCleanup {
  let destroyed = false;
  const isCrossOriginSubframe = (() => {
    if (window.top === window.self) return false;
    try {
      void window.top?.location.href;
      return false;
    } catch {
      return true;
    }
  })();
  if (isCrossOriginSubframe) {
    return { destroy: () => {} };
  }

  const shouldTriggerForInput = (input: HTMLInputElement): boolean => {
    if (!isElementVisuallySafe(input)) return false;
    const isPasswordInput = input.type === "password";
    const isAssociatedUsername = findAssociatedPasswordInput(input) !== null;
    const isLikelyUsername = isLikelyUsernameInput(input);
    return isPasswordInput || isAssociatedUsername || isLikelyUsername;
  };

  const focusHandler = (e: FocusEvent) => {
    if (destroyed) return;
    const input = e.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (!isUsableInput(input)) return;

    // Trigger for password inputs, associated usernames, and likely login IDs.
    if (!shouldTriggerForInput(input)) return;

    requestMatches(input);
  };

  const blurHandler = (e: FocusEvent) => {
    if (destroyed) return;
    // Only hide if focus left the dropdown context input
    if (currentContext && e.target === currentContext.input) {
      // Delay to allow mousedown on dropdown items
      setTimeout(() => {
        if (currentContext && currentContext.input !== document.activeElement) {
          hideDropdown();
        }
      }, 150);
    }
  };

  const keydownHandler = (e: KeyboardEvent) => {
    if (destroyed) return;
    if (isDropdownVisible()) {
      handleDropdownKeydown(e);
    }
  };

  // Scan existing inputs
  const scanInputs = () => {
    const passwordInputs = findPasswordInputs(document);
    for (const input of passwordInputs) {
      trackInput(input);
      const usernameInput = findUsernameInput(input);
      if (usernameInput) trackInput(usernameInput);
    }
  };

  // MutationObserver for dynamically added inputs (SPA support)
  const observer = new MutationObserver((mutations) => {
    if (destroyed) return;
    let hasNewNodes = false;
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        hasNewNodes = true;
        break;
      }
    }
    if (hasNewNodes) scanInputs();
  });

  // SPA navigation detection
  const navigationHandler = () => {
    if (destroyed) return;
    hideDropdown();
    // Re-scan after navigation
    setTimeout(scanInputs, 100);
  };

  function trackInput(input: HTMLInputElement): void {
    if (trackedInputs.has(input)) return;
    trackedInputs.add(input);
    // No per-input listener needed — we use document-level focus capture
  }

  function requestMatches(input: HTMLInputElement): void {
    if (!isContextValid()) {
      destroy();
      return;
    }
    if (
      !isPageVisuallySafe() ||
      !isElementVisuallySafe(input) ||
      !isInputHitTestSafe(input) ||
      hasVisiblePopoverOverlayNear(input)
    ) {
      hideDropdown();
      currentContext = null;
      return;
    }
    const url = window.location.href;
    let topUrl: string | undefined;
    try {
      topUrl = window.top?.location?.href;
    } catch {
      topUrl = undefined;
    }
    try {
      chrome.runtime.sendMessage(
        { type: "GET_MATCHES_FOR_URL", url, topUrl },
        (response) => {
          if (destroyed) return;
          if (!isContextValid()) { destroy(); return; }
          if (chrome.runtime.lastError) return;
          if (!response) return;
          showForInput(
            input,
            response.entries ?? [],
            response.vaultLocked ?? false,
            response.suppressInline ?? false,
          );
        },
      );
    } catch {
      destroy();
    }
  }

  // Listen for vault state changes (sent from popup after unlock/lock)
  const runtimeMessageHandler = (message: { type?: string }) => {
    if (destroyed) return;
    if (message?.type !== "PSSO_VAULT_STATE_CHANGED" && message?.type !== "PSSO_TRIGGER_INLINE_SUGGESTIONS") return;
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && shouldTriggerForInput(active)) {
      requestMatches(active);
      return;
    }
    if (message?.type === "PSSO_TRIGGER_INLINE_SUGGESTIONS") {
      const firstCandidate = Array.from(document.querySelectorAll<HTMLInputElement>("input")).find(
        (i) => shouldTriggerForInput(i),
      );
      if (firstCandidate) {
        firstCandidate.focus();
        requestMatches(firstCandidate);
      }
    }
  };
  chrome.runtime.onMessage.addListener(runtimeMessageHandler);

  // Start
  document.addEventListener("focusin", focusHandler, true);
  document.addEventListener("focusout", blurHandler, true);
  document.addEventListener("keydown", keydownHandler, true);
  scanInputs();
  observer.observe(document.body, { childList: true, subtree: true });

  // SPA navigation listeners
  if (typeof navigation !== "undefined") {
    navigation.addEventListener("navigate", navigationHandler);
  }
  window.addEventListener("popstate", navigationHandler);
  window.addEventListener("hashchange", navigationHandler);

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    chrome.runtime.onMessage.removeListener(runtimeMessageHandler);
    document.removeEventListener("focusin", focusHandler, true);
    document.removeEventListener("focusout", blurHandler, true);
    document.removeEventListener("keydown", keydownHandler, true);
    observer.disconnect();
    hideDropdown();
    removeShadowHost();
    if (typeof navigation !== "undefined") {
      navigation.removeEventListener("navigate", navigationHandler);
    }
    window.removeEventListener("popstate", navigationHandler);
    window.removeEventListener("hashchange", navigationHandler);
  }

  return { destroy };
}

// ── Helpers ─────────────────────────────────────────────────

function findAssociatedPasswordInput(
  input: HTMLInputElement,
): HTMLInputElement | null {
  if (input.type === "password") return input;
  const form = input.closest("form");
  const scope: ParentNode = form ?? document;
  const passwordInputs = findPasswordInputs(scope);
  for (const pw of passwordInputs) {
    const username = findUsernameInput(pw);
    if (username === input) return pw;
  }
  return null;
}
