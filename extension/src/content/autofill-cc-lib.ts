// Pure logic module for credit card autofill execution (exported, testable).
// Side-effect-free — no global event registration here.

import type { CreditCardAutofillPayload } from "../types/messages";
import {
  detectCreditCardFields,
  detectExpiryFormat,
  formatCombinedExpiry,
} from "./cc-form-detector-lib";

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

/** Normalize month values for select matching: "1" → "01", "January" → "01", etc. */
const MONTH_NAMES: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
  jan: "01", feb: "02", mar: "03", apr: "04",
  jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  "1月": "01", "2月": "02", "3月": "03", "4月": "04",
  "5月": "05", "6月": "06", "7月": "07", "8月": "08",
  "9月": "09", "10月": "10", "11月": "11", "12月": "12",
};

function normalizeMonthValue(value: string): string {
  const lower = value.toLowerCase().trim();
  if (MONTH_NAMES[lower]) return MONTH_NAMES[lower];
  const num = parseInt(lower, 10);
  if (!Number.isNaN(num) && num >= 1 && num <= 12) return String(num).padStart(2, "0");
  return lower;
}

function normalizeYearValue(value: string): string {
  const trimmed = value.trim();
  const num = parseInt(trimmed, 10);
  if (Number.isNaN(num)) return trimmed;
  // Short year: "25" stays "25", full year "2025" stays "2025"
  return String(num);
}

function setSelectValue(select: HTMLSelectElement, targetValue: string, normalizer: (v: string) => string): void {
  if (!isFieldVisible(select)) return;

  const normalizedTarget = normalizer(targetValue);

  // Find exact match after normalization
  const options = Array.from(select.options);
  const match = options.find((opt) => {
    const normalizedOpt = normalizer(opt.value);
    return normalizedOpt === normalizedTarget;
  }) ?? options.find((opt) => {
    const normalizedOpt = normalizer(opt.textContent?.trim() ?? "");
    return normalizedOpt === normalizedTarget;
  });

  if (!match) {
    // Silent failure — no fuzzy/nearest match per security review
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

export function performCreditCardAutofill(payload: CreditCardAutofillPayload): void {
  const fields = detectCreditCardFields(document);
  if (!fields) return;

  if (fields.cardholderName && payload.cardholderName) {
    setInputValue(fields.cardholderName, payload.cardholderName);
  }

  if (fields.cardNumber && payload.cardNumber) {
    setInputValue(fields.cardNumber, payload.cardNumber);
  }

  // Expiry
  if (fields.expiryFormat === "combined" && fields.expiryCombined) {
    const format = detectExpiryFormat(fields.expiryCombined);
    const combined = formatCombinedExpiry(payload.expiryMonth, payload.expiryYear, format);
    setInputValue(fields.expiryCombined, combined);
  } else {
    if (fields.expiryMonth && payload.expiryMonth) {
      if (fields.expiryMonth instanceof HTMLSelectElement) {
        setSelectValue(fields.expiryMonth, payload.expiryMonth, normalizeMonthValue);
      } else {
        setInputValue(fields.expiryMonth, payload.expiryMonth);
      }
    }
    if (fields.expiryYear && payload.expiryYear) {
      if (fields.expiryYear instanceof HTMLSelectElement) {
        setSelectValue(fields.expiryYear, payload.expiryYear, normalizeYearValue);
      } else {
        setInputValue(fields.expiryYear, payload.expiryYear);
      }
    }
  }

  if (fields.cvv && payload.cvv) {
    setInputValue(fields.cvv, payload.cvv);
    // CVV memory wipe — overwrite payload property immediately after use
    payload.cvv = "";
  }
}
