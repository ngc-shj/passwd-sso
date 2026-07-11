// Pure logic module for credit card form detection (exported, testable).
// detectCreditCardFields is side-effect-free; initCreditCardDetector wires the
// inline-suggestion lifecycle (focus → match request → dropdown → fill).

import type { DecryptedEntry } from "../types/messages";
import { t } from "../lib/i18n";
import { EXT_MSG, PSSO_VAULT_STATE_CHANGED, PSSO_TRIGGER_INLINE_SUGGESTIONS } from "../lib/constants";
import {
  isUsableInput,
  isElementVisuallySafe,
  isPageVisuallySafe,
  isInputHitTestSafe,
  hasVisiblePopoverOverlayNear,
  showInlineNotice,
} from "./form-detector-lib";
import {
  showDropdown,
  hideDropdown,
  isDropdownVisible,
  handleDropdownKeydown,
} from "./ui/suggestion-dropdown";

// ── Types ──

export interface CreditCardFormFields {
  cardholderName: HTMLInputElement | null;
  cardNumber: HTMLInputElement | null;
  expiryMonth: HTMLInputElement | HTMLSelectElement | null;
  expiryYear: HTMLInputElement | HTMLSelectElement | null;
  expiryCombined: HTMLInputElement | null;
  cvv: HTMLInputElement | null;
  expiryFormat: "split" | "combined";
}

// ── Visibility check (reuse pattern from form-detector-lib.ts) ──

function resolveOpacity(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 1;
}

export function isElementVisible(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (resolveOpacity(style.opacity) <= 0.05) return false;
  return true;
}

// ── Field detection helpers ──

function getHintString(el: HTMLElement): string {
  const parts: string[] = [];
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) {
    if (el.name) parts.push(el.name);
    if (el.id) parts.push(el.id);
    if (el instanceof HTMLInputElement && el.placeholder) parts.push(el.placeholder);
  }
  if (el.getAttribute("aria-label")) parts.push(el.getAttribute("aria-label")!);
  // Walk up to find associated label
  const id = el.id;
  if (id && typeof CSS !== "undefined" && CSS.escape) {
    const label = el.ownerDocument.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`);
    if (label?.textContent) parts.push(label.textContent);
  }
  const parentLabel = el.closest("label");
  if (parentLabel?.textContent) parts.push(parentLabel.textContent);
  return parts.join(" ").toLowerCase();
}

function getAutocomplete(el: HTMLElement): string {
  return (el.getAttribute("autocomplete") ?? "").toLowerCase().trim();
}

function isUsableField(el: HTMLInputElement | HTMLSelectElement): boolean {
  if (el instanceof HTMLInputElement) {
    return !el.disabled && !el.readOnly;
  }
  return !el.disabled;
}

// ── Regex patterns ──

export const CC_DETECT_RE = {
  number:      /card.?num|cc.?num|\bcard.?no\b|\bccno\b|\bpan\b/i,
  name:        /card.?holder|holder.?name|cc.?name|card.?name|name.?on.?card|meigi/i,
  expiryMonth: /exp(?:ir(?:y|e|ation))?[^a-z0-9]{0,2}month|card.?month|cc.?month|expire\W{0,2}mm?\b/i,
  expiryYear:  /exp(?:ir(?:y|e|ation))?[^a-z0-9]{0,2}year|card.?year|cc.?year|expire\W{0,2}yy?\b/i,
  cvv:         /cvv|cvc|csc|cv2|security.?code|security.?cd|\bcard.?verif|conf.?num|card.?code/i,
} as const;

const CC_NUMBER_JA_RE = /カード番号/;
const CC_NAME_JA_RE = /名義|カード名義/;

const CC_EXPIRY_RE = /expir|exp.?date|valid.?thru|card.?exp/i;
const CC_EXPIRY_JA_RE = /有効期限/;

const CC_EXPIRY_MONTH_JA_RE = /月/;
const CC_EXPIRY_YEAR_JA_RE = /年/;

const CC_CVV_JA_RE = /セキュリティコード/;

// ── Autocomplete attributes (standard) ──

const AC_CC_NUMBER = "cc-number";
const AC_CC_NAME = "cc-name";
const AC_CC_EXP = "cc-exp";
const AC_CC_EXP_MONTH = "cc-exp-month";
const AC_CC_EXP_YEAR = "cc-exp-year";
const AC_CC_CSC = "cc-csc";

// ── Field finder ──

function findFieldByAutocomplete(
  fields: (HTMLInputElement | HTMLSelectElement)[],
  acValue: string,
): HTMLInputElement | HTMLSelectElement | null {
  return fields.find((f) => getAutocomplete(f) === acValue && isUsableField(f)) ?? null;
}

function findFieldByRegex(
  fields: (HTMLInputElement | HTMLSelectElement)[],
  regex: RegExp,
  regexJa: RegExp,
): HTMLInputElement | HTMLSelectElement | null {
  return (
    fields.find((f) => {
      if (!isUsableField(f)) return false;
      const hint = getHintString(f);
      return regex.test(hint) || regexJa.test(hint);
    }) ?? null
  );
}

// ── Combined expiry format detection ──

export function detectExpiryFormat(el: HTMLInputElement): "MM/YY" | "MM/YYYY" | "MMYY" | "MMYYYY" {
  const placeholder = (el.placeholder || "").toUpperCase();
  if (placeholder.includes("MM/YYYY") || placeholder.includes("MM / YYYY")) return "MM/YYYY";
  if (placeholder.includes("MM/YY") || placeholder.includes("MM / YY")) return "MM/YY";
  if (placeholder.includes("MMYYYY")) return "MMYYYY";
  if (placeholder.includes("MMYY")) return "MMYY";

  const maxLength = el.maxLength;
  if (maxLength === 7) return "MM/YYYY";
  if (maxLength === 5) return "MM/YY";
  if (maxLength === 6) return "MMYYYY";
  if (maxLength === 4) return "MMYY";

  return "MM/YY"; // default
}

export function formatCombinedExpiry(
  month: string,
  year: string,
  format: "MM/YY" | "MM/YYYY" | "MMYY" | "MMYYYY",
): string {
  const mm = month.padStart(2, "0");
  const yy = year.length > 2 ? year.slice(-2) : year.padStart(2, "0");
  const yyyy = year.length === 4 ? year : `20${yy}`;

  switch (format) {
    case "MM/YY":
      return `${mm}/${yy}`;
    case "MM/YYYY":
      return `${mm}/${yyyy}`;
    case "MMYY":
      return `${mm}${yy}`;
    case "MMYYYY":
      return `${mm}${yyyy}`;
  }
}

// ── Main detection function ──

export function detectCreditCardFields(root: ParentNode): CreditCardFormFields | null {
  const inputs = Array.from(root.querySelectorAll<HTMLInputElement>("input"));
  const selects = Array.from(root.querySelectorAll<HTMLSelectElement>("select"));
  const allFields: (HTMLInputElement | HTMLSelectElement)[] = [...inputs, ...selects];

  // Only consider visible fields
  const visibleFields = allFields.filter(
    (f) => isElementVisible(f) && isUsableField(f),
  );

  if (visibleFields.length === 0) return null;

  // Priority 1: autocomplete attributes
  let cardNumber = findFieldByAutocomplete(visibleFields, AC_CC_NUMBER) as HTMLInputElement | null;
  let cardholderName = findFieldByAutocomplete(visibleFields, AC_CC_NAME) as HTMLInputElement | null;
  let expiryCombined = findFieldByAutocomplete(visibleFields, AC_CC_EXP) as HTMLInputElement | null;
  let expiryMonth = findFieldByAutocomplete(visibleFields, AC_CC_EXP_MONTH);
  let expiryYear = findFieldByAutocomplete(visibleFields, AC_CC_EXP_YEAR);
  let cvv = findFieldByAutocomplete(visibleFields, AC_CC_CSC) as HTMLInputElement | null;

  // Priority 2: name/id/label regex fallback
  if (!cardNumber) {
    cardNumber = findFieldByRegex(visibleFields, CC_DETECT_RE.number, CC_NUMBER_JA_RE) as HTMLInputElement | null;
  }
  if (!cardholderName) {
    cardholderName = findFieldByRegex(visibleFields, CC_DETECT_RE.name, CC_NAME_JA_RE) as HTMLInputElement | null;
  }
  if (!cvv) {
    cvv = findFieldByRegex(visibleFields, CC_DETECT_RE.cvv, CC_CVV_JA_RE) as HTMLInputElement | null;
  }
  if (!expiryMonth && !expiryCombined) {
    // Check for combined expiry first
    const combined = findFieldByRegex(visibleFields, CC_EXPIRY_RE, CC_EXPIRY_JA_RE);
    if (combined && combined instanceof HTMLInputElement) {
      expiryCombined = combined;
    } else {
      expiryMonth = findFieldByRegex(visibleFields, CC_DETECT_RE.expiryMonth, CC_EXPIRY_MONTH_JA_RE);
    }
  }
  if (!expiryYear && !expiryCombined) {
    expiryYear = findFieldByRegex(visibleFields, CC_DETECT_RE.expiryYear, CC_EXPIRY_YEAR_JA_RE);
  }

  // Must have at least card number to consider this a CC form
  if (!cardNumber) return null;

  const hasCombined = expiryCombined !== null;

  return {
    cardholderName,
    cardNumber,
    expiryMonth: hasCombined ? null : expiryMonth,
    expiryYear: hasCombined ? null : expiryYear,
    expiryCombined: hasCombined ? expiryCombined : null,
    cvv,
    expiryFormat: hasCombined ? "combined" : "split",
  };
}

// ── Inline detector ─────────────────────────────────────────

declare const navigation: EventTarget | undefined;

export interface CreditCardDetectorCleanup {
  destroy: () => void;
}

function isContextValid(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

/** Collect the detected CC field elements into a membership set for O(1) focus lookup. */
function collectCcFields(fields: CreditCardFormFields, into: WeakSet<HTMLElement>): void {
  const candidates = [
    fields.cardholderName,
    fields.cardNumber,
    fields.expiryMonth,
    fields.expiryYear,
    fields.expiryCombined,
    fields.cvv,
  ];
  for (const el of candidates) {
    if (el) into.add(el);
  }
}

/**
 * Initialize the inline credit-card suggestion detector. Mirrors the LOGIN
 * detector but with detector-LOCAL suppression state and a CC-field WeakSet,
 * so it neither scans the DOM per focus nor cross-suppresses the LOGIN dropdown.
 */
export function initCreditCardDetector(): CreditCardDetectorCleanup {
  let destroyed = false;

  // S2: a malicious cross-origin subframe must not render a deceptive dropdown.
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

  // F2: membership set rebuilt by scan + MutationObserver, not per-focus scan.
  let ccFields = new WeakSet<HTMLElement>();
  // F1: detector-local suppression — never shared with the LOGIN module.
  let autofillSuppressUntil = 0;
  let activeInput: HTMLInputElement | null = null;

  const rescan = () => {
    if (destroyed) return;
    const next = new WeakSet<HTMLElement>();
    const fields = detectCreditCardFields(document);
    if (fields) collectCcFields(fields, next);
    ccFields = next;
  };

  const requestMatches = (input: HTMLInputElement) => {
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
      activeInput = null;
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
        { type: EXT_MSG.GET_CC_MATCHES_FOR_URL, url, topUrl },
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
            response.disconnected ?? false,
          );
        },
      );
    } catch {
      destroy();
    }
  };

  const showForInput = (
    input: HTMLInputElement,
    entries: DecryptedEntry[],
    vaultLocked: boolean,
    suppressInline: boolean,
    disconnected: boolean,
  ) => {
    if (suppressInline) {
      hideDropdown();
      activeInput = null;
      return;
    }
    activeInput = input;
    showDropdown({
      anchorRect: input.getBoundingClientRect(),
      entries,
      vaultLocked,
      disconnected,
      entryType: "CREDIT_CARD",
      onSelect: (entryId, teamId) => {
        if (!isContextValid()) return;
        autofillSuppressUntil = Date.now() + 1500;
        chrome.runtime.sendMessage(
          { type: EXT_MSG.AUTOFILL_FROM_CONTENT, entryId, ...(teamId ? { teamId } : {}) },
          (resp?: { ok?: boolean; error?: string }) => {
            if (!isContextValid()) return;
            if (chrome.runtime.lastError) {
              showInlineNotice(input, t("errors.autofillFailed"));
              return;
            }
            if (!resp?.ok) {
              if (resp?.error === "VAULT_LOCKED") {
                showInlineNotice(input, t("contentScript.vaultLocked"));
              } else if (resp?.error === "NO_CARD_NUMBER") {
                showInlineNotice(input, t("errors.noCardNumber"));
              } else {
                showInlineNotice(input, t("errors.autofillFailed"));
              }
              return;
            }
            hideDropdown();
          },
        );
      },
      onDismiss: () => {
        activeInput = null;
      },
      lockedMessage: t("contentScript.vaultLocked"),
      disconnectedMessage: t("contentScript.disconnected"),
      noMatchesMessage: t("contentScript.noCreditCards"),
      headerLabel: t("contentScript.creditCards"),
    });
  };

  const focusHandler = (e: FocusEvent) => {
    if (destroyed) return;
    if (Date.now() < autofillSuppressUntil) return;
    const input = e.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (!isUsableInput(input)) return;
    if (!ccFields.has(input)) return;
    requestMatches(input);
  };

  const blurHandler = (e: FocusEvent) => {
    if (destroyed) return;
    if (activeInput && e.target === activeInput) {
      setTimeout(() => {
        if (activeInput && activeInput !== document.activeElement) {
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

  const observer = new MutationObserver((mutations) => {
    if (destroyed) return;
    if (mutations.some((m) => m.addedNodes.length > 0)) rescan();
  });

  // F7: re-evaluate the active element after vault unlock / explicit trigger.
  const runtimeMessageHandler = (message: { type?: string }) => {
    if (destroyed) return;
    if (
      message?.type !== PSSO_VAULT_STATE_CHANGED &&
      message?.type !== PSSO_TRIGGER_INLINE_SUGGESTIONS
    ) {
      return;
    }
    rescan();
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && ccFields.has(active) && isUsableInput(active)) {
      requestMatches(active);
    }
  };

  try {
    chrome.runtime.onMessage?.addListener(runtimeMessageHandler);
  } catch {
    // Extension context invalidated — skip listener registration.
  }

  document.addEventListener("focusin", focusHandler, true);
  document.addEventListener("focusout", blurHandler, true);
  document.addEventListener("keydown", keydownHandler, true);
  rescan();
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }

  const navigationHandler = () => {
    if (destroyed) return;
    hideDropdown();
    setTimeout(rescan, 100);
  };
  if (typeof navigation !== "undefined") {
    navigation.addEventListener("navigate", navigationHandler);
  }
  window.addEventListener("popstate", navigationHandler);
  window.addEventListener("hashchange", navigationHandler);

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    try {
      chrome.runtime.onMessage?.removeListener(runtimeMessageHandler);
    } catch {
      // Extension context invalidated.
    }
    document.removeEventListener("focusin", focusHandler, true);
    document.removeEventListener("focusout", blurHandler, true);
    document.removeEventListener("keydown", keydownHandler, true);
    observer.disconnect();
    if (typeof navigation !== "undefined") {
      navigation.removeEventListener("navigate", navigationHandler);
    }
    window.removeEventListener("popstate", navigationHandler);
    window.removeEventListener("hashchange", navigationHandler);
    // F6: detectors only hide the dropdown; the shared shadow host is removed
    // once by the entry-point teardown, not per-detector.
    hideDropdown();
  }

  return { destroy };
}
