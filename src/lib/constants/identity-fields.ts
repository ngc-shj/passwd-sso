/**
 * Single source of truth for identity-entry field keys.
 *
 * Identity entries store both the legacy monolithic fields (`fullName`, `address`)
 * and the structured fields below, additively. Structured fields enable the browser
 * extension to fill split name/address forms field-by-field; legacy entries keep
 * working via monolithic fallback.
 *
 * Import this const-object everywhere instead of scattering string literals.
 */
export const IDENTITY_FIELD = {
  // Legacy monolithic (kept for back-compat + combined-form fill)
  FULL_NAME: "fullName",
  ADDRESS: "address",
  // Structured name
  GIVEN_NAME: "givenName",
  FAMILY_NAME: "familyName",
  MIDDLE_NAME: "middleName",
  FAMILY_NAME_KANA: "familyNameKana",
  GIVEN_NAME_KANA: "givenNameKana",
  // Structured address
  ADDRESS_LINE1: "addressLine1",
  ADDRESS_LINE2: "addressLine2",
  CITY: "city",
  STATE: "state",
  POSTAL_CODE: "postalCode",
  COUNTRY: "country",
  // Other identity fields
  PHONE: "phone",
  EMAIL: "email",
  DATE_OF_BIRTH: "dateOfBirth",
  NATIONALITY: "nationality",
  ID_NUMBER: "idNumber",
  ISSUE_DATE: "issueDate",
  EXPIRY_DATE: "expiryDate",
} as const;

export type IdentityFieldKey = (typeof IDENTITY_FIELD)[keyof typeof IDENTITY_FIELD];

/**
 * Structured name keys added in v1 (alongside legacy `fullName`).
 * `familyNameKana`/`givenNameKana` are フリガナ; regex-only detection in the extension.
 */
export const IDENTITY_STRUCTURED_NAME_KEYS = [
  IDENTITY_FIELD.GIVEN_NAME,
  IDENTITY_FIELD.FAMILY_NAME,
  IDENTITY_FIELD.MIDDLE_NAME,
  IDENTITY_FIELD.FAMILY_NAME_KANA,
  IDENTITY_FIELD.GIVEN_NAME_KANA,
] as const;

/**
 * Structured address keys added in v1 (alongside legacy `address`).
 */
export const IDENTITY_STRUCTURED_ADDRESS_KEYS = [
  IDENTITY_FIELD.ADDRESS_LINE1,
  IDENTITY_FIELD.ADDRESS_LINE2,
  IDENTITY_FIELD.CITY,
  IDENTITY_FIELD.STATE,
  IDENTITY_FIELD.POSTAL_CODE,
  IDENTITY_FIELD.COUNTRY,
] as const;

/**
 * Compose the overview name label at WRITE time: prefer the legacy `fullName`,
 * otherwise build it from structured given/family. Returns null when neither exists
 * (so a blank entry stays blank rather than showing whitespace).
 *
 * The overview blob is encrypted before it reaches any downstream consumer
 * (extension dropdown, list view), so this must be computed when the blob is built.
 */
export function composeIdentityNameLabel(
  fullName: string | null | undefined,
  givenName: string | null | undefined,
  familyName: string | null | undefined,
): string | null {
  const full = fullName?.trim();
  if (full) return full;
  const composed = `${givenName?.trim() ?? ""} ${familyName?.trim() ?? ""}`.trim();
  return composed || null;
}
