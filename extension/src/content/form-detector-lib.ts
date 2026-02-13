// Pure logic module for form detection (exported, testable).
// Side-effect-free — no global event registration here.

// Navigation API — not yet in all TypeScript lib types
declare const navigation: EventTarget | undefined;

import type { DecryptedEntry } from "../types/messages";
import { t } from "../lib/i18n";
import {
  showDropdown,
  hideDropdown,
  isDropdownVisible,
  handleDropdownKeydown,
} from "./ui/suggestion-dropdown";
import { removeShadowHost } from "./ui/shadow-host";

// ── Form field detection ────────────────────────────────────

const trackedInputs = new WeakSet<HTMLInputElement>();

export function isUsableInput(input: HTMLInputElement): boolean {
  return !input.disabled && !input.readOnly;
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

// ── Dropdown integration ────────────────────────────────────

interface DropdownContext {
  input: HTMLInputElement;
  entries: DecryptedEntry[];
  vaultLocked: boolean;
}

let currentContext: DropdownContext | null = null;

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
): void {
  const rect = input.getBoundingClientRect();
  const msgs = getMessages();

  currentContext = { input, entries, vaultLocked };

  showDropdown({
    anchorRect: rect,
    entries,
    vaultLocked,
    onSelect: (entryId) => {
      hideDropdown();
      chrome.runtime.sendMessage({ type: "AUTOFILL_FROM_CONTENT", entryId });
    },
    onDismiss: () => {
      currentContext = null;
    },
    lockedMessage: msgs.locked,
    noMatchesMessage: msgs.noMatches,
    headerLabel: msgs.header,
  });
}

// ── Core initialization ─────────────────────────────────────

export interface FormDetectorCleanup {
  destroy: () => void;
}

export function initFormDetector(): FormDetectorCleanup {
  let destroyed = false;

  const focusHandler = (e: FocusEvent) => {
    if (destroyed) return;
    const input = e.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (!isUsableInput(input)) return;

    // Only trigger for password inputs or their associated username inputs
    const isPasswordInput = input.type === "password";
    const isAssociatedUsername = findAssociatedPasswordInput(input) !== null;
    if (!isPasswordInput && !isAssociatedUsername) return;

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
    const url = window.location.href;
    chrome.runtime.sendMessage(
      { type: "GET_MATCHES_FOR_URL", url },
      (response) => {
        if (destroyed) return;
        if (chrome.runtime.lastError) return;
        if (!response) return;
        showForInput(input, response.entries ?? [], response.vaultLocked ?? false);
      },
    );
  }

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
