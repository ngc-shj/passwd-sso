// The one console sink permitted under src/content/ (eslint.extension.config.mjs).
//
// The diagnostic names the FIELD the extension was trying to fill, from a closed set
// this module owns. It deliberately reads nothing from the DOM.
//
// An earlier version logged the select's own `name`/`id` on the reasoning that they
// are page-authored and therefore reveal nothing new. That was wrong in a way worth
// recording: `setInputValue` dispatches `input` synchronously, so a page listener
// runs BEFORE the next field is filled and can move a value the extension has already
// written into the next select's `name` —
//
//   cardNumber.addEventListener("input", () => { expiryMonth.name = cardNumber.value; });
//
// — after which the mismatch diagnostic logs the card number. The page does not learn
// anything (it already holds what it moved), but it gains the ability to push the
// user's secrets into a log surface only the extension can write to: DevTools/CDP
// capture, automation harnesses, telemetry agents, support bundles. Sanitising did not
// help — digits and letters are exactly what a PAN or a name is made of.
//
// A closed union has no such hole, and it makes the sanitiser and the length cap
// unnecessary: there is no page-derived string left to bound.

export const SELECT_DIAG_FIELD = {
  CC_EXPIRY_MONTH: "cc-expiry-month",
  CC_EXPIRY_YEAR: "cc-expiry-year",
  IDENTITY_GIVEN_NAME: "identity-given-name",
  IDENTITY_FAMILY_NAME: "identity-family-name",
  IDENTITY_FULL_NAME: "identity-full-name",
  IDENTITY_FAMILY_NAME_KANA: "identity-family-name-kana",
  IDENTITY_GIVEN_NAME_KANA: "identity-given-name-kana",
  IDENTITY_ADDRESS: "identity-address",
  IDENTITY_ADDRESS_LINE2: "identity-address-line2",
  IDENTITY_CITY: "identity-city",
  IDENTITY_POSTAL_CODE: "identity-postal-code",
  IDENTITY_COUNTRY: "identity-country",
  IDENTITY_REGION: "identity-region",
  IDENTITY_PHONE: "identity-phone",
  IDENTITY_EMAIL: "identity-email",
  IDENTITY_DATE_OF_BIRTH: "identity-date-of-birth",
} as const;

export type SelectDiagField =
  (typeof SELECT_DIAG_FIELD)[keyof typeof SELECT_DIAG_FIELD];

export function logNoSelectMatch(field: SelectDiagField): void {
  if (typeof console !== "undefined" && console.debug) {
    console.debug(`[passwd-sso] No exact match for select: ${field}`);
  }
}
