// Credit card inline detector and expiry formatting. Field detection itself
// (detectCreditCardFields) lives in cc-field-detection-lib; initCreditCardDetector
// wires the inline-suggestion lifecycle (focus → match request → dropdown → fill).

import type { DecryptedEntry } from "../types/messages";
import { t } from "../lib/i18n";
import { EXT_MSG, PSSO_VAULT_STATE_CHANGED, PSSO_TRIGGER_INLINE_SUGGESTIONS } from "../lib/constants";
import {
  isPageVisuallySafe,
  isInputHitTestSafe,
  hasVisiblePopoverOverlayNear,
  showInlineNotice,
} from "./form-detector-lib";
import { isUsableInput, isDropdownFieldVisible, memberAdmission } from "./field-query-lib";
import { ccClaimedFields } from "./cc-field-detection-lib";
import {
  showDropdown,
  hideDropdown,
  isDropdownVisible,
  handleDropdownKeydown,
} from "./ui/suggestion-dropdown";
import { isFillActive, OBSERVED_ATTRIBUTES } from "./fill-sequence-lib";
import { createRescanScheduler, ATTR_RESCAN_DELAY_MS, ATTR_RECENT_MS } from "./rescan-scheduler";

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
  // Fields the last scan rejected as hidden (see fillAdmission).
  let hiddenAtScan = new WeakSet<Element>();
  // F1: detector-local suppression — never shared with the LOGIN module.
  let autofillSuppressUntil = 0;
  let activeInput: HTMLInputElement | null = null;

  const rescan = () => {
    if (destroyed) return;
    const next = new WeakSet<HTMLElement>();
    const hidden = new WeakSet<Element>();
    const admit = memberAdmission(hidden);
    // Each form's own detection too: a page-wide detection claims one field
    // per role, so a second card form would otherwise get no dropdown.
    for (const root of [document, ...Array.from(document.forms)]) {
      for (const el of ccClaimedFields(root, admit)) next.add(el);
    }
    ccFields = next;
    hiddenAtScan = hidden;
  };

  // Coalesces attribute-only mutation bursts so a reveal made
  // without adding nodes still gets picked up, without scanning per mutation.
  const scheduler = createRescanScheduler(rescan, {
    delayMs: ATTR_RESCAN_DELAY_MS,
    recentMs: ATTR_RECENT_MS,
  });

  const requestMatches = (input: HTMLInputElement) => {
    if (!isContextValid()) {
      destroy();
      return;
    }
    if (
      !isPageVisuallySafe() ||
      !isDropdownFieldVisible(input) ||
      !isInputHitTestSafe(input) ||
      hasVisiblePopoverOverlayNear(input)
    ) {
      hideDropdown();
      activeInput = null;
      return;
    }
    // The SW derives the page URL from MessageSender, not from this message.
    try {
      chrome.runtime.sendMessage(
        { type: EXT_MSG.GET_CC_MATCHES_FOR_URL },
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
          {
            type: EXT_MSG.AUTOFILL_FROM_CONTENT,
            entryId,
            ...(teamId ? { teamId } : {}),
            // C6: onSelect only fires from a trusted click/keydown (see
            // suggestion-dropdown.ts isSafeSelectClick) — safe to mark as activity.
            userGesture: true,
          },
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
    // A fill moves focus field by field; the dropdown stays closed until it ends.
    if (isFillActive()) return;
    const input = e.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (!isUsableInput(input)) return;
    if (!ccFields.has(input)) {
      // A member focus never scans. A non-member gets one last chance —
      // drain any mutation not yet delivered, then flush a pending or recent
      // rescan — before giving up on it.
      handleMutations(observer.takeRecords());
      scheduler.flushForFocus();
      // A reveal no observed mutation shows (a CSS-only :checked/:target rule,
      // a transition, an <html> class, a media query): a field the last scan
      // saw hidden is rendered now, so one scan admits it. A field that was
      // never hidden costs no scan.
      if (!ccFields.has(input) && hiddenAtScan.has(input) && isDropdownFieldVisible(input)) rescan();
      if (!ccFields.has(input)) return;
    }
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

  // Named so the focus path can feed it observer.takeRecords() directly.
  const handleMutations = (mutations: MutationRecord[]): void => {
    if (destroyed) return;
    if (mutations.some((m) => m.addedNodes.length > 0)) {
      scheduler.runNow();
      return;
    }
    // A batch often carries many records for one element (style + class);
    // each target is inspected once.
    const seen = new Set<Node>();
    if (
      mutations.some((m) => {
        const target = m.target;
        if (seen.has(target)) return false;
        seen.add(target);
        return (
          target instanceof Element &&
          (target.matches?.("input,select") || target.querySelector?.("input,select"))
        );
      })
    ) {
      scheduler.noteAttributeChange();
    }
  };

  const observer = new MutationObserver(handleMutations);

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
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [...OBSERVED_ATTRIBUTES],
    });
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
    scheduler.cancel();
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
