// Pure logic module for identity/address form detection (exported, testable).
// detectIdentityFields is side-effect-free; initIdentityDetector wires the
// inline-suggestion lifecycle (focus → match request → dropdown → fill).

import type { DecryptedEntry } from "../types/messages";
import { t } from "../lib/i18n";
import { EXT_MSG, PSSO_VAULT_STATE_CHANGED, PSSO_TRIGGER_INLINE_SUGGESTIONS } from "../lib/constants";
import {
  isUsableInput,
  isUsableFieldOfType,
  isElementVisuallySafe,
  isPageVisuallySafe,
  isInputHitTestSafe,
  hasVisiblePopoverOverlayNear,
  showInlineNotice,
} from "./form-detector-lib";
import { detectCreditCardFields } from "./cc-form-detector-lib";
import {
  showDropdown,
  hideDropdown,
  isDropdownVisible,
  handleDropdownKeydown,
} from "./ui/suggestion-dropdown";

// ── Types ──

export interface IdentityFormFields {
  fullName: HTMLInputElement | null;
  givenName: HTMLInputElement | null;
  familyName: HTMLInputElement | null;
  familyNameKana: HTMLInputElement | null;
  givenNameKana: HTMLInputElement | null;
  address: HTMLInputElement | null;
  addressLine2: HTMLInputElement | null;
  city: HTMLInputElement | HTMLSelectElement | null;
  postalCode: HTMLInputElement | null;
  phone: HTMLInputElement | null;
  email: HTMLInputElement | null;
  dateOfBirth: HTMLInputElement | null;
  region: HTMLInputElement | HTMLSelectElement | null;
  country: HTMLInputElement | HTMLSelectElement | null;
}

// ── Visibility check ──

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

// Only free-text-like input types can receive identity autofill. Radio /
// checkbox / hidden / submit etc. must never be claimed: e.g. a 2FA method
// chooser `<input type="radio" id="Email">` matches EMAIL_RE by hint and
// would otherwise trigger the identity dropdown on focus.
const FILLABLE_INPUT_TYPES = new Set([
  "text",
  "email",
  "tel",
  "number",
  "search",
  "url",
  "date",
  "month",
]);

const isUsableField = (el: HTMLInputElement | HTMLSelectElement): boolean =>
  isUsableFieldOfType(el, FILLABLE_INPUT_TYPES);

// ── Regex patterns ──

const NAME_RE = /\b(full.?name|your.?name|first.?name|last.?name|name)\b/i;
const NAME_JA_RE = /氏名|お名前|名前|姓名/;

const GIVEN_NAME_RE = /\b(first.?name|given.?name|forename)\b/i;
const GIVEN_NAME_JA_RE = /名/;

const FAMILY_NAME_RE = /\b(last.?name|family.?name|surname)\b/i;
const FAMILY_NAME_JA_RE = /姓/;

// Kana (フリガナ) — regex-only, no autocomplete token. A kana hint must contain
// フリガナ/カナ/かな; the SEI/MEI半角 distinction (セイ/姓 vs メイ/名) picks family vs given.
const KANA_RE = /フリガナ|カナ|かな/;
const KANA_FAMILY_RE = /セイ|姓/;
const KANA_GIVEN_RE = /メイ|名/;

const ADDRESS_RE = /\b(address|street|addr|address.?line|shipping.?address|billing.?address)\b/i;
export const ADDRESS_JA_RE = /住所|番地|丁目/;

const ADDRESS_LINE2_RE = /\b(address.?line.?2|apartment|apt|suite|unit|building)\b/i;
const ADDRESS_LINE2_JA_RE = /建物|部屋|号室|マンション/;

const CITY_RE = /\b(city|town|locality|suburb)\b/i;
const CITY_JA_RE = /市区町村|市町村|区市町村/;

const COUNTRY_RE = /\b(country)\b/i;
const COUNTRY_JA_RE = /国/;

const POSTAL_RE = /\b(zip|postal|post.?code|zip.?code)\b/i;
const POSTAL_JA_RE = /郵便番号/;

const PHONE_RE = /\b(phone|tel|telephone|mobile|cell)\b/i;
const PHONE_JA_RE = /電話|携帯/;

const EMAIL_RE = /\b(email|e.?mail)\b/i;
const EMAIL_JA_RE = /メール/;

const DOB_RE = /\b(birth|dob|date.?of.?birth|birthday)\b/i;
const DOB_JA_RE = /生年月日|誕生日/;

const REGION_RE = /\b(state|province|region|prefecture|county)\b/i;
const REGION_JA_RE = /都道府県|県/;

// ── Autocomplete values ──

const AC_NAME = "name";
const AC_GIVEN_NAME = "given-name";
const AC_FAMILY_NAME = "family-name";
const AC_ADDRESS_LINE1 = "address-line1";
const AC_ADDRESS_LINE2 = "address-line2";
const AC_ADDRESS_LEVEL2 = "address-level2";
const AC_POSTAL_CODE = "postal-code";
const AC_TEL = "tel";
const AC_EMAIL = "email";
const AC_BDAY = "bday";
const AC_ADDRESS_LEVEL1 = "address-level1";
const AC_COUNTRY_NAME = "country-name";

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

/**
 * Find a kana (フリガナ) field. A kana field's hint MUST contain フリガナ/カナ/かな
 * (guards against matching the plain 姓/名 fields), AND the SEI/MEI selector
 * (KANA_FAMILY_RE for セイ/姓, KANA_GIVEN_RE for メイ/名) picks family vs given.
 */
function findKanaField(
  fields: (HTMLInputElement | HTMLSelectElement)[],
  seiMeiRegex: RegExp,
): HTMLInputElement | null {
  return (
    (fields.find((f) => {
      if (!isUsableField(f)) return false;
      const hint = getHintString(f);
      return KANA_RE.test(hint) && seiMeiRegex.test(hint);
    }) as HTMLInputElement | undefined) ?? null
  );
}

/** Find a plain (non-kana) given/family field — its hint must NOT be a kana hint. */
function findPlainNameField(
  fields: (HTMLInputElement | HTMLSelectElement)[],
  regex: RegExp,
  regexJa: RegExp,
): HTMLInputElement | null {
  return (
    (fields.find((f) => {
      if (!isUsableField(f)) return false;
      const hint = getHintString(f);
      if (KANA_RE.test(hint)) return false;
      return regex.test(hint) || regexJa.test(hint);
    }) as HTMLInputElement | undefined) ?? null
  );
}

// ── Main detection function ──

export function detectIdentityFields(root: ParentNode): IdentityFormFields | null {
  const inputs = Array.from(root.querySelectorAll<HTMLInputElement>("input"));
  const selects = Array.from(root.querySelectorAll<HTMLSelectElement>("select"));
  const allFields: (HTMLInputElement | HTMLSelectElement)[] = [...inputs, ...selects];

  // C4: a field already claimed by CC detection must never also be claimed by
  // identity detection — otherwise the identity focus handler races the CC
  // dropdown and can overwrite it on a card field.
  const ccFields = detectCreditCardFields(root);
  const ccClaimed = new Set<HTMLElement>();
  if (ccFields) {
    for (const el of [
      ccFields.cardholderName,
      ccFields.cardNumber,
      ccFields.expiryMonth,
      ccFields.expiryYear,
      ccFields.expiryCombined,
      ccFields.cvv,
    ]) {
      if (el) ccClaimed.add(el);
    }
  }

  const visibleFields = allFields.filter(
    (f) => isElementVisible(f) && isUsableField(f) && !ccClaimed.has(f),
  );

  if (visibleFields.length === 0) return null;

  // Priority 1: autocomplete attributes
  let fullName = findFieldByAutocomplete(visibleFields, AC_NAME) as HTMLInputElement | null;
  let givenName = findFieldByAutocomplete(visibleFields, AC_GIVEN_NAME) as HTMLInputElement | null;
  let familyName = findFieldByAutocomplete(visibleFields, AC_FAMILY_NAME) as HTMLInputElement | null;
  let address = findFieldByAutocomplete(visibleFields, AC_ADDRESS_LINE1) as HTMLInputElement | null;
  let addressLine2 = findFieldByAutocomplete(visibleFields, AC_ADDRESS_LINE2) as HTMLInputElement | null;
  let city = findFieldByAutocomplete(visibleFields, AC_ADDRESS_LEVEL2);
  let postalCode = findFieldByAutocomplete(visibleFields, AC_POSTAL_CODE) as HTMLInputElement | null;
  let phone = findFieldByAutocomplete(visibleFields, AC_TEL) as HTMLInputElement | null;
  let email = findFieldByAutocomplete(visibleFields, AC_EMAIL) as HTMLInputElement | null;
  let dateOfBirth = findFieldByAutocomplete(visibleFields, AC_BDAY) as HTMLInputElement | null;
  let region = findFieldByAutocomplete(visibleFields, AC_ADDRESS_LEVEL1);
  let country = findFieldByAutocomplete(visibleFields, AC_COUNTRY_NAME);

  // Kana (フリガナ) — regex-only, no autocomplete token. Detect FIRST so a kana
  // field is never mis-claimed by the plain given/family regex (and vice versa:
  // findPlainNameField rejects any hint that also matches KANA_RE).
  const familyNameKana = findKanaField(visibleFields, KANA_FAMILY_RE);
  const givenNameKana = findKanaField(visibleFields, KANA_GIVEN_RE);

  // Priority 2: name/id/label regex fallback. Plain given/family use a kana-aware
  // finder so フリガナ fields don't leak in; the JA family/given regex (姓/名) also
  // appears inside 氏名 (fullName) — exclude an already-claimed fullName element.
  if (!fullName) {
    fullName = findFieldByRegex(visibleFields, NAME_RE, NAME_JA_RE) as HTMLInputElement | null;
  }
  if (!givenName) {
    const candidate = findPlainNameField(visibleFields, GIVEN_NAME_RE, GIVEN_NAME_JA_RE);
    givenName = candidate === fullName ? null : candidate;
  }
  if (!familyName) {
    const candidate = findPlainNameField(visibleFields, FAMILY_NAME_RE, FAMILY_NAME_JA_RE);
    familyName = candidate === fullName ? null : candidate;
  }
  if (!address) {
    address = findFieldByRegex(visibleFields, ADDRESS_RE, ADDRESS_JA_RE) as HTMLInputElement | null;
  }
  if (!addressLine2) {
    addressLine2 = findFieldByRegex(visibleFields, ADDRESS_LINE2_RE, ADDRESS_LINE2_JA_RE) as HTMLInputElement | null;
  }
  if (!city) {
    city = findFieldByRegex(visibleFields, CITY_RE, CITY_JA_RE);
  }
  if (!postalCode) {
    postalCode = findFieldByRegex(visibleFields, POSTAL_RE, POSTAL_JA_RE) as HTMLInputElement | null;
  }
  if (!phone) {
    phone = findFieldByRegex(visibleFields, PHONE_RE, PHONE_JA_RE) as HTMLInputElement | null;
  }
  if (!email) {
    email = findFieldByRegex(visibleFields, EMAIL_RE, EMAIL_JA_RE) as HTMLInputElement | null;
  }
  if (!dateOfBirth) {
    dateOfBirth = findFieldByRegex(visibleFields, DOB_RE, DOB_JA_RE) as HTMLInputElement | null;
  }
  if (!region) {
    region = findFieldByRegex(visibleFields, REGION_RE, REGION_JA_RE);
  }
  if (!country) {
    country = findFieldByRegex(visibleFields, COUNTRY_RE, COUNTRY_JA_RE);
  }

  // Must have at least 2 fields to consider this an identity form
  const fieldCount = [
    fullName,
    givenName,
    familyName,
    familyNameKana,
    givenNameKana,
    address,
    addressLine2,
    city,
    postalCode,
    phone,
    email,
    dateOfBirth,
    region,
    country,
  ].filter(Boolean).length;
  if (fieldCount < 2) return null;

  return {
    fullName,
    givenName,
    familyName,
    familyNameKana,
    givenNameKana,
    address,
    addressLine2,
    city,
    postalCode,
    phone,
    email,
    dateOfBirth,
    region,
    country,
  };
}

// ── Inline detector ─────────────────────────────────────────

declare const navigation: EventTarget | undefined;

export interface IdentityDetectorCleanup {
  destroy: () => void;
}

function isContextValid(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

/** Collect the detected identity field elements into a membership set for O(1) focus lookup. */
function collectIdentityFields(fields: IdentityFormFields, into: WeakSet<HTMLElement>): void {
  const candidates = [
    fields.fullName,
    fields.givenName,
    fields.familyName,
    fields.familyNameKana,
    fields.givenNameKana,
    fields.address,
    fields.addressLine2,
    fields.city,
    fields.postalCode,
    fields.phone,
    fields.email,
    fields.dateOfBirth,
    fields.region,
    fields.country,
  ];
  for (const el of candidates) {
    if (el) into.add(el);
  }
}

/**
 * Initialize the inline identity suggestion detector. Mirrors the LOGIN detector
 * but with detector-LOCAL suppression state and an identity-field WeakSet.
 */
export function initIdentityDetector(): IdentityDetectorCleanup {
  let destroyed = false;

  // S2: cross-origin subframe must not render a deceptive dropdown.
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

  let identityFields = new WeakSet<HTMLElement>();
  let autofillSuppressUntil = 0;
  let activeInput: HTMLInputElement | null = null;

  const rescan = () => {
    if (destroyed) return;
    const next = new WeakSet<HTMLElement>();
    const fields = detectIdentityFields(document);
    if (fields) collectIdentityFields(fields, next);
    identityFields = next;
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
        { type: EXT_MSG.GET_IDENTITY_MATCHES_FOR_URL, url, topUrl },
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
      entryType: "IDENTITY",
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
      noMatchesMessage: t("contentScript.noIdentities"),
      headerLabel: t("contentScript.identities"),
    });
  };

  const focusHandler = (e: FocusEvent) => {
    if (destroyed) return;
    if (Date.now() < autofillSuppressUntil) return;
    const input = e.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (!isUsableInput(input)) return;
    if (!identityFields.has(input)) return;
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
    if (active instanceof HTMLInputElement && identityFields.has(active) && isUsableInput(active)) {
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
    // F6: shared shadow host removed once by entry-point teardown.
    hideDropdown();
  }

  return { destroy };
}
