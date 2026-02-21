// Login detection module — captures credentials on form submit or button click.
// Separated from form-detector-lib.ts (already 586+ lines) as an independent module.
// Side-effect-free — call initLoginDetector() to start.

import { findPasswordInputs, findUsernameInput } from "./form-detector-lib";
import { showSaveBanner, hideSaveBanner } from "./ui/save-banner";
import type { ExtensionResponse } from "../types/messages";

export interface LoginDetectorCleanup {
  destroy: () => void;
}

/** Regex patterns for form actions that indicate non-login forms. */
const SKIP_ACTION_RE = /\/(reset|forgot|register|signup|sign-up|join|create-account)/i;

/** Field names/autocomplete values hinting at a registration form. */
const REGISTRATION_FIELD_RE =
  /^(name|first.?name|last.?name|full.?name|phone|tel|address|city|state|zip|postal|country|birth|dob|age|gender|company|organization)$/i;

/** Debounce interval to prevent duplicate LOGIN_DETECTED for the same action. */
const DETECT_DEBOUNCE_MS = 2_000;

/**
 * Determine if a form looks like a password-change or registration form
 * (not a login form) and should be skipped.
 */
export function shouldSkipForm(form: HTMLFormElement): boolean {
  const passwordInputs = findPasswordInputs(form);

  // Multiple password fields → password change / registration form
  if (passwordInputs.length >= 2) return true;

  // Check form action URL for non-login paths
  const action = form.action || "";
  if (action && SKIP_ACTION_RE.test(action)) return true;

  // Too many additional fields → likely a registration form
  const allInputs = Array.from(form.querySelectorAll<HTMLInputElement>("input"));
  const extraFields = allInputs.filter((input) => {
    if (input.type === "hidden" || input.type === "submit" || input.type === "button") return false;
    if (input.type === "password") return false;
    // Check if this is a username/email field (expected in login forms)
    if (input.type === "email" || input.autocomplete === "username") return false;
    if (input.type === "text" || input.type === "tel") {
      const fieldName = (input.name || input.id || input.autocomplete || "").toLowerCase();
      return REGISTRATION_FIELD_RE.test(fieldName);
    }
    return false;
  });
  if (extraFields.length >= 3) return true;

  // autocomplete="new-password" is a strong registration signal, but many
  // real login forms set it incorrectly. Only skip when combined with at
  // least one other indicator (registration-like extra fields).
  const hasNewPasswordAttr = passwordInputs.some((p) => p.autocomplete === "new-password");
  if (hasNewPasswordAttr && extraFields.length >= 1) return true;

  return false;
}

/**
 * Extract credentials from a form, if it looks like a login form.
 * Returns null if the form should be skipped or has no usable credentials.
 */
export function extractCredentials(
  form: HTMLFormElement,
): { username: string; password: string } | null {
  if (shouldSkipForm(form)) return null;

  const passwordInputs = findPasswordInputs(form);
  if (passwordInputs.length !== 1) return null;

  const passwordInput = passwordInputs[0];
  const password = passwordInput.value;
  if (!password) return null;

  const usernameInput = findUsernameInput(passwordInput);
  const username = usernameInput?.value ?? "";

  return { username, password };
}

/**
 * Search the page (or a form scope) for a filled password input and extract
 * credentials. Used by click-based detection when there's no <form> submit.
 */
export function extractCredentialsFromPage(): { username: string; password: string } | null {
  const passwordInputs = findPasswordInputs(document);
  // Filter to visible, filled password fields
  const filled = passwordInputs.filter((p) => p.value);
  if (filled.length === 0 || filled.length > 2) return null;

  // Use the last filled password input (most likely the active one)
  const passwordInput = filled[filled.length - 1];
  const password = passwordInput.value;
  if (!password) return null;

  // If the password is inside a form, check if the form should be skipped
  const form = passwordInput.closest("form");
  if (form && shouldSkipForm(form)) return null;

  const usernameInput = findUsernameInput(passwordInput);
  const username = usernameInput?.value ?? "";

  return { username, password };
}

/**
 * Initialize the login detector. Listens for form submit events (capture phase),
 * submit-like button clicks, and pulls pending saves from the background.
 */
export function initLoginDetector(): LoginDetectorCleanup {
  let lastDetectTime = 0;

  function isContextValid(): boolean {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  /** Send LOGIN_DETECTED to background and handle response. */
  function sendLoginDetected(credentials: { username: string; password: string }): void {
    const now = Date.now();
    if (now - lastDetectTime < DETECT_DEBOUNCE_MS) return;
    lastDetectTime = now;

    const url = window.location.href;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return;
    }

    chrome.runtime.sendMessage(
      {
        type: "LOGIN_DETECTED",
        url,
        username: credentials.username,
        password: credentials.password,
      },
      (response?: ExtensionResponse) => {
        if (chrome.runtime.lastError) return;
        if (!response || response.type !== "LOGIN_DETECTED") return;
        if (response.action === "none") return;

        showSaveBannerForResponse(
          host,
          credentials.username,
          credentials.password,
          response.action,
          response.existingEntryId,
          response.existingTitle,
        );
      },
    );
  }

  /** Show save banner with appropriate callbacks. */
  function showSaveBannerForResponse(
    host: string,
    username: string,
    password: string,
    action: "save" | "update",
    existingEntryId?: string,
    existingTitle?: string,
  ): void {
    showSaveBanner({
      host,
      username,
      action,
      existingTitle,
      onSave: () => {
        chrome.runtime.sendMessage({
          type: "SAVE_LOGIN",
          url: window.location.href,
          title: host,
          username,
          password,
        });
      },
      onUpdate: () => {
        if (existingEntryId) {
          chrome.runtime.sendMessage({
            type: "UPDATE_LOGIN",
            entryId: existingEntryId,
            password,
          });
        }
      },
      onDismiss: () => {
        chrome.runtime.sendMessage({ type: "DISMISS_SAVE_PROMPT" });
      },
    });
  }

  // ── Form submit handler (capture phase) ──

  function onSubmit(event: SubmitEvent): void {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (!isContextValid()) return;

    const credentials = extractCredentials(form);
    if (!credentials) return;

    sendLoginDetected(credentials);
  }

  document.addEventListener("submit", onSubmit, true);

  // ── Click handler for submit-like buttons ──
  // Catches logins on pages that use <button onclick="..."> instead of
  // standard <form> submit events. Many test/practice sites and SPAs do this.

  function onButtonClick(event: MouseEvent): void {
    if (!isContextValid()) return;

    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    // Walk up to find the actual button/link element
    const button = target.closest<HTMLElement>(
      'button, input[type="submit"], input[type="button"], [role="button"], a[href]',
    );
    if (!button) return;

    // Heuristic: only consider buttons that look like submit/login buttons
    if (!isSubmitLikeButton(button)) return;

    // Look for credentials on the page
    const credentials = extractCredentialsFromPage();
    if (!credentials) return;

    sendLoginDetected(credentials);
  }

  document.addEventListener("click", onButtonClick, true);

  // ── Push handler: background sends save banner after navigation ──

  function onShowSaveBanner(message: {
    type?: string;
    host?: string;
    username?: string;
    password?: string;
    action?: "save" | "update" | "none";
    existingEntryId?: string;
    existingTitle?: string;
  }): void {
    if (message?.type !== "PSSO_SHOW_SAVE_BANNER") return;
    if (!message.action || message.action === "none") return;

    showSaveBannerForResponse(
      message.host || "",
      message.username || "",
      message.password || "",
      message.action,
      message.existingEntryId,
      message.existingTitle,
    );
  }

  // Guard: chrome.runtime.onMessage may be undefined when extension
  // context is invalidated (e.g., extension reload on an existing page).
  try {
    chrome.runtime.onMessage?.addListener(onShowSaveBanner);
  } catch {
    // Extension context invalidated — skip message listener registration
  }

  // ── Pull mechanism: check for pending saves on init ──
  // After navigation, tabs.onUpdated may fire before this content script
  // loads (document_idle). Pull pending saves as a fallback.

  if (isContextValid()) {
    chrome.runtime.sendMessage(
      { type: "CHECK_PENDING_SAVE" },
      (response?: ExtensionResponse) => {
        try { if (chrome.runtime.lastError) return; } catch { return; }
        if (!response || response.type !== "CHECK_PENDING_SAVE") return;
        if (response.action === "none") return;

        showSaveBannerForResponse(
          response.host || "",
          response.username || "",
          response.password || "",
          response.action,
          response.existingEntryId,
          response.existingTitle,
        );
      },
    );
  }

  return {
    destroy() {
      document.removeEventListener("submit", onSubmit, true);
      document.removeEventListener("click", onButtonClick, true);
      try {
        chrome.runtime.onMessage?.removeListener(onShowSaveBanner);
      } catch {
        // Extension context invalidated
      }
      hideSaveBanner();
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────

/** Heuristic: check if an element looks like a login/submit button. */
function isSubmitLikeButton(el: HTMLElement): boolean {
  // Standard submit buttons
  if (el instanceof HTMLInputElement && (el.type === "submit" || el.type === "button")) {
    return true;
  }
  if (el instanceof HTMLButtonElement) {
    // type="reset" is never a submit
    if (el.type === "reset") return false;
    // type="submit" is obvious
    if (el.type === "submit") return true;
    // type="button" — check text content
  }

  // Check text content and attributes for submit-like keywords
  const text = (
    el.textContent ||
    el.getAttribute("value") ||
    el.getAttribute("aria-label") ||
    ""
  ).toLowerCase().trim();

  const submitRe = /^(log\s*in|sign\s*in|submit|login|signin|サインイン|ログイン|送信|次へ|next|continue|go|enter)$/i;
  if (submitRe.test(text)) return true;

  // Check id/name/class for login-related hints
  const hints = [
    el.id,
    el.getAttribute("name"),
    el.className,
  ].filter(Boolean).join(" ").toLowerCase();

  return /\b(login|signin|sign-in|submit|log-in)\b/.test(hints);
}
