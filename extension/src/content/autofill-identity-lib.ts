// Pure logic module for identity/address autofill execution (exported, testable).
// Side-effect-free — no global event registration here.

import type { IdentityAutofillPayload } from "../types/messages";
import { detectIdentityFields } from "./identity-form-detector-lib";

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

function setSelectValue(select: HTMLSelectElement, targetValue: string): void {
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
    if (typeof console !== "undefined" && console.debug) {
      console.debug(`[passwd-sso] No exact match for select value: ${targetValue}`);
    }
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

export function performIdentityAutofill(payload: IdentityAutofillPayload): void {
  const fields = detectIdentityFields(document);
  if (!fields) return;

  if (fields.fullName && payload.fullName) {
    setInputValue(fields.fullName, payload.fullName);
  }

  if (fields.address && payload.address) {
    setInputValue(fields.address, payload.address);
  }

  if (fields.phone && payload.phone) {
    setInputValue(fields.phone, payload.phone);
  }

  if (fields.email && payload.email) {
    setInputValue(fields.email, payload.email);
  }

  if (fields.dateOfBirth && payload.dateOfBirth) {
    setInputValue(fields.dateOfBirth, payload.dateOfBirth);
  }

  // Region can be either input or select
  if (fields.region && payload.nationality) {
    if (fields.region instanceof HTMLSelectElement) {
      setSelectValue(fields.region, payload.nationality);
    } else {
      setInputValue(fields.region, payload.nationality);
    }
  }
}
