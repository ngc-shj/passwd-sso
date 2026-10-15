// Identity/address autofill: exported performIdentityAutofill (pure, testable)
// plus a self-registering AUTOFILL_IDENTITY_FILL listener, mirroring autofill-lib.ts.

import { EXT_MSG } from "../lib/constants";
import type { IdentityAutofillPayload, FillResponse } from "../types/messages";
import { isInsecureHttpUrl } from "../lib/url-matching";
import {
  detectIdentityFields,
  isIdentityCandidate,
  isIdentityFillable,
  isIdentityRegionFillable,
  type IdentityFormFields,
} from "./identity-form-detector-lib";
import { fillAdmission } from "./field-query-lib";
import {
  focusScopedFields,
  resolveFillRoot,
  runFillSequence,
  supersedeActiveFill,
  type FillStep,
  type FillTarget,
} from "./fill-sequence-lib";
import {
  FILL_DIAG_CODE,
  logFillError,
  logNoSelectMatch,
  SELECT_DIAG_FIELD,
  type SelectDiagField,
} from "./select-diag-lib";

// ── Value setters ──
// Every write runs in the task where its step's `accepts` has just passed
// (runFillSequence), so the setters do not re-check visibility.

function setInputValue(input: HTMLInputElement, value: string): boolean {
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
  // Taken before any event runs, so a page handler that rewrites the field
  // cannot decide it. A value the input's type rejects (a postcode in
  // type=number, 01/15/1990 in type=date) is sanitized to "" without an error;
  // that is the only case read as not taken. Exact equality is not required:
  // the browser also normalizes values it accepts (an email's surrounding
  // whitespace).
  const took = value === "" || input.value !== "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  input.dispatchEvent(new Event("blur", { bubbles: true }));
  return took;
}

function setSelectValue(
  select: HTMLSelectElement,
  targetValue: string,
  diagField: SelectDiagField,
): boolean {
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
    return false;
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
  return true;
}

// ── Main autofill function ──

const IDENTITY_ROLES = [
  "fullName",
  "givenName",
  "familyName",
  "familyNameKana",
  "givenNameKana",
  "address",
  "addressLine2",
  "city",
  "postalCode",
  "phone",
  "email",
  "dateOfBirth",
  "region",
  "country",
] as const satisfies readonly (keyof IdentityFormFields)[];

// The roles whose select may be geometry-hidden (Select2 / selectWoo). Every
// other role, date of birth and postal code included, gets the full rule.
const GEOMETRY_EXEMPT_ROLES: ReadonlySet<keyof IdentityFormFields> = new Set(["country", "region"]);

function writeField(el: FillTarget, value: string, diagField: SelectDiagField): boolean {
  if (el instanceof HTMLSelectElement) return setSelectValue(el, value, diagField);
  return setInputValue(el, value);
}

export async function performIdentityAutofill(
  payload: IdentityAutofillPayload,
  opts: { lateFieldWindowMs?: number } = {},
): Promise<number> {
  // Never into an insecure http page, where a network attacker can serve the
  // form: by the frame's URL, or by the origin an about:blank or srcdoc frame
  // inherits. The request still ends this frame's pending fill.
  if (isInsecureHttpUrl(window.location.href) || isInsecureHttpUrl(self.origin)) {
    supersedeActiveFill();
    return 0;
  }

  // T0: the detector's result, scoped to the block the user is in, is every
  // step's initial target.
  const admit = fillAdmission();
  const fields = focusScopedFields<IdentityFormFields>({
    // One admission (and so one visibility cache) for every detection the
    // scope runs: it climbs ancestors and checks their siblings.
    detect: (root) => detectIdentityFields(root, admit),
    roles: (f) => IDENTITY_ROLES.map((role) => f[role]),
    anchors: () => true,
    // A sibling holding two of the roles already held is another block
    // (shipping beside billing); a confirm-email row or a split phone is one
    // duplicate field and is not.
    competes: (other, held) =>
      IDENTITY_ROLES.filter((role) => other[role] !== null && held[role] !== null).length >= 2,
  });
  if (!fields) {
    supersedeActiveFill();
    return 0;
  }

  const steps: FillStep[] = [];
  // A step whose payload value is empty is not created.
  const addStep = (
    field: keyof IdentityFormFields,
    value: () => string,
    diagField: SelectDiagField,
  ) => {
    if (!value()) return;
    steps.push({
      key: field,
      initial: fields[field],
      relocate: (root) => detectIdentityFields(root)?.[field] ?? null,
      accepts: GEOMETRY_EXEMPT_ROLES.has(field) ? isIdentityRegionFillable : isIdentityFillable,
      write: (el) => writeField(el, value(), diagField),
      release: () => {},
    });
  };

  // ── Name ──
  // Prefer structured given/family; fall back to the monolithic fullName ONLY for
  // a combined `name` field. NEVER split fullName into the split fields (forbidden).
  // A page with no split name field still gets the entry's own fullName, even
  // when the entry also has structured names (never composed from them: the
  // given/family order differs by locale).
  const hasStructuredName = Boolean(payload.givenName || payload.familyName);
  const pageHasSplitName = fields.givenName !== null || fields.familyName !== null;
  addStep("givenName", () => payload.givenName, SELECT_DIAG_FIELD.IDENTITY_GIVEN_NAME);
  addStep("familyName", () => payload.familyName, SELECT_DIAG_FIELD.IDENTITY_FAMILY_NAME);
  if (!hasStructuredName || !pageHasSplitName) {
    addStep("fullName", () => payload.fullName, SELECT_DIAG_FIELD.IDENTITY_FULL_NAME);
  }

  // Kana (フリガナ) — structured only, no monolithic fallback.
  addStep(
    "familyNameKana",
    () => payload.familyNameKana,
    SELECT_DIAG_FIELD.IDENTITY_FAMILY_NAME_KANA,
  );
  addStep(
    "givenNameKana",
    () => payload.givenNameKana,
    SELECT_DIAG_FIELD.IDENTITY_GIVEN_NAME_KANA,
  );

  // ── Address ──
  // The `address` slot already carries structured addressLine1 when present and
  // the monolithic address otherwise (resolved in the background); filling the
  // address-line1 field from a single value is not a mis-split.
  addStep("address", () => payload.address, SELECT_DIAG_FIELD.IDENTITY_ADDRESS);
  addStep(
    "addressLine2",
    () => payload.addressLine2,
    SELECT_DIAG_FIELD.IDENTITY_ADDRESS_LINE2,
  );
  addStep("city", () => payload.city, SELECT_DIAG_FIELD.IDENTITY_CITY);
  addStep(
    "postalCode",
    () => payload.postalCode,
    SELECT_DIAG_FIELD.IDENTITY_POSTAL_CODE,
  );
  addStep("country", () => payload.country, SELECT_DIAG_FIELD.IDENTITY_COUNTRY);

  // Region (address-level1) prefers the structured state, falling back to the
  // legacy nationality value for entries that predate the structured fields.
  addStep(
    "region",
    () => payload.state || payload.nationality,
    SELECT_DIAG_FIELD.IDENTITY_REGION,
  );

  addStep("phone", () => payload.phone, SELECT_DIAG_FIELD.IDENTITY_PHONE);
  addStep("email", () => payload.email, SELECT_DIAG_FIELD.IDENTITY_EMAIL);
  addStep(
    "dateOfBirth",
    () => payload.dateOfBirth,
    SELECT_DIAG_FIELD.IDENTITY_DATE_OF_BIRTH,
  );

  const t0Targets = Object.values(fields).filter(
    (el): el is HTMLInputElement | HTMLSelectElement => el !== null,
  );
  const anchor = steps.map((step) => step.initial).find((el) => el !== null) ?? null;
  const { root, reanchor } = anchor
    ? resolveFillRoot(anchor, t0Targets, isIdentityCandidate)
    : { root: null, reanchor: () => null };

  return runFillSequence(root, steps, { ...opts, reanchor });
}

// Guard against double-registration (manifest content script + programmatic re-injection).
const IDENTITY_AUTOFILL_GUARD = "__pssoIdentityAutofillHandler";
if (
  typeof chrome !== "undefined" &&
  chrome.runtime?.onMessage &&
  !(window as unknown as Record<string, boolean>)[IDENTITY_AUTOFILL_GUARD]
) {
  (window as unknown as Record<string, boolean>)[IDENTITY_AUTOFILL_GUARD] = true;
  chrome.runtime.onMessage.addListener(
    (
      message: IdentityAutofillPayload,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response: FillResponse) => void,
    ) => {
      // Only accept messages from our own extension — reject external senders
      if (message?.type !== EXT_MSG.AUTOFILL_IDENTITY_FILL || sender.id !== chrome.runtime.id) return false;
      // Sent to one document only, so this frame always answers; a refusal or
      // an empty page answers 0.
      performIdentityAutofill(message).then(
        (filled) => sendResponse({ filled }),
        () => {
          logFillError(FILL_DIAG_CODE.IDENTITY_FILL_FAILED);
          sendResponse({ filled: 0 });
        },
      );
      return true;
    },
  );
}
