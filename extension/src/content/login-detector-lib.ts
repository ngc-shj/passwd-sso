// Login detection module — captures credentials on form submit.
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

/**
 * Determine if a form looks like a password-change or registration form
 * (not a login form) and should be skipped.
 */
export function shouldSkipForm(form: HTMLFormElement): boolean {
  const passwordInputs = findPasswordInputs(form);

  // Multiple password fields → password change / registration form
  if (passwordInputs.length >= 2) return true;

  // autocomplete="new-password" → registration / change form
  if (passwordInputs.some((p) => p.autocomplete === "new-password")) return true;

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
 * Initialize the login detector. Listens for form submit events (capture phase)
 * and sends LOGIN_DETECTED messages to the background.
 */
export function initLoginDetector(): LoginDetectorCleanup {
  function onSubmit(event: SubmitEvent): void {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;

    // Check extension context is still valid
    try {
      if (!chrome.runtime?.id) return;
    } catch {
      return;
    }

    const credentials = extractCredentials(form);
    if (!credentials) return;

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

        showSaveBanner({
          host,
          username: credentials.username,
          action: response.action,
          existingTitle: response.existingTitle,
          onSave: () => {
            chrome.runtime.sendMessage({
              type: "SAVE_LOGIN",
              url,
              title: host,
              username: credentials.username,
              password: credentials.password,
            });
          },
          onUpdate: () => {
            if (response.existingEntryId) {
              chrome.runtime.sendMessage({
                type: "UPDATE_LOGIN",
                entryId: response.existingEntryId,
                password: credentials.password,
              });
            }
          },
          onDismiss: () => {
            chrome.runtime.sendMessage({ type: "DISMISS_SAVE_PROMPT" });
          },
        });
      },
    );
  }

  // Capture phase — fires before navigation
  document.addEventListener("submit", onSubmit, true);

  return {
    destroy() {
      document.removeEventListener("submit", onSubmit, true);
      hideSaveBanner();
    },
  };
}
