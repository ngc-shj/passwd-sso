// Identity/address autofill: exported performIdentityAutofill (pure, testable)
// plus a self-registering AUTOFILL_IDENTITY_FILL listener, mirroring autofill-lib.ts.

import { EXT_MSG } from "../lib/constants";
import type { IdentityAutofillPayload } from "../types/messages";
import { detectIdentityFields } from "./identity-form-detector-lib";
import {
  logNoSelectMatch,
  SELECT_DIAG_FIELD,
  type SelectDiagField,
} from "./select-diag-lib";

// ── Visibility check ──

function isFieldVisible(el: HTMLElement): boolean {
  const style = getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden";
}

// ── Value setters ──

function setInputValue(input: HTMLInputElement, value: string): void {
  if (!isFieldVisible(input)) return;
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  if (setter) {
    setter.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  input.dispatchEvent(new Event("blur", { bubbles: true }));
}

function setSelectValue(
  select: HTMLSelectElement,
  targetValue: string,
  diagField: SelectDiagField,
): void {
  if (!isFieldVisible(select)) return;

  const normalizedTarget = targetValue.trim().toLowerCase();

  // Exact match by value first, then by text content
  const options = Array.from(select.options);
  const match = options.find((opt) => {
    return opt.value.trim().toLowerCase() === normalizedTarget;
  }) ?? options.find((opt) => {
    return (opt.textContent?.trim() ?? "").toLowerCase() === normalizedTarget;
  });

  if (!match) {
    // Only the extension's own field identifier is logged. fillField routes every
    // identity field here when the element is a <select>, so the target VALUE can
    // be the user's name, address, phone, email or date of birth — and nothing
    // read from the DOM reaches the console either.
    logNoSelectMatch(diagField);
    return;
  }

  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )?.set;
  if (setter) {
    setter.call(select, match.value);
  } else {
    select.value = match.value;
  }
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

// ── Main autofill function ──

function fillField(
  field: HTMLInputElement | HTMLSelectElement | null,
  value: string,
  diagField: SelectDiagField,
): void {
  if (!field || !value) return;
  if (field instanceof HTMLSelectElement) {
    setSelectValue(field, value, diagField);
  } else {
    setInputValue(field, value);
  }
}

export function performIdentityAutofill(payload: IdentityAutofillPayload): void {
  const fields = detectIdentityFields(document);
  if (!fields) return;

  // ── Name ──
  // Prefer structured given/family; fall back to the monolithic fullName ONLY for
  // a combined `name` field. NEVER split fullName into the split fields (forbidden).
  const hasStructuredName = Boolean(payload.givenName || payload.familyName);
  fillField(fields.givenName, payload.givenName, SELECT_DIAG_FIELD.IDENTITY_GIVEN_NAME);
  fillField(fields.familyName, payload.familyName, SELECT_DIAG_FIELD.IDENTITY_FAMILY_NAME);
  if (!hasStructuredName) {
    fillField(fields.fullName, payload.fullName, SELECT_DIAG_FIELD.IDENTITY_FULL_NAME);
  }

  // Kana (フリガナ) — structured only, no monolithic fallback.
  fillField(
    fields.familyNameKana,
    payload.familyNameKana,
    SELECT_DIAG_FIELD.IDENTITY_FAMILY_NAME_KANA,
  );
  fillField(
    fields.givenNameKana,
    payload.givenNameKana,
    SELECT_DIAG_FIELD.IDENTITY_GIVEN_NAME_KANA,
  );

  // ── Address ──
  // The `address` slot already carries structured addressLine1 when present and
  // the monolithic address otherwise (resolved in the background); filling the
  // address-line1 field from a single value is not a mis-split.
  fillField(fields.address, payload.address, SELECT_DIAG_FIELD.IDENTITY_ADDRESS);
  fillField(
    fields.addressLine2,
    payload.addressLine2,
    SELECT_DIAG_FIELD.IDENTITY_ADDRESS_LINE2,
  );
  fillField(fields.city, payload.city, SELECT_DIAG_FIELD.IDENTITY_CITY);
  fillField(
    fields.postalCode,
    payload.postalCode,
    SELECT_DIAG_FIELD.IDENTITY_POSTAL_CODE,
  );
  fillField(fields.country, payload.country, SELECT_DIAG_FIELD.IDENTITY_COUNTRY);

  // Region (address-level1) prefers the structured state, falling back to the
  // legacy nationality value for entries that predate the structured fields.
  fillField(
    fields.region,
    payload.state || payload.nationality,
    SELECT_DIAG_FIELD.IDENTITY_REGION,
  );

  fillField(fields.phone, payload.phone, SELECT_DIAG_FIELD.IDENTITY_PHONE);
  fillField(fields.email, payload.email, SELECT_DIAG_FIELD.IDENTITY_EMAIL);
  fillField(
    fields.dateOfBirth,
    payload.dateOfBirth,
    SELECT_DIAG_FIELD.IDENTITY_DATE_OF_BIRTH,
  );
}

// Guard against double-registration (manifest content script + programmatic re-injection).
const IDENTITY_AUTOFILL_GUARD = "__pssoIdentityAutofillHandler";
if (
  typeof chrome !== "undefined" &&
  chrome.runtime?.onMessage &&
  !(window as unknown as Record<string, boolean>)[IDENTITY_AUTOFILL_GUARD]
) {
  (window as unknown as Record<string, boolean>)[IDENTITY_AUTOFILL_GUARD] = true;
  chrome.runtime.onMessage.addListener((message: IdentityAutofillPayload, sender: chrome.runtime.MessageSender) => {
    // Only accept messages from our own extension — reject external senders
    if (message?.type === EXT_MSG.AUTOFILL_IDENTITY_FILL && sender.id === chrome.runtime.id) {
      performIdentityAutofill(message);
    }
  });
}
