/**
 * Share permission levels.
 *
 * - VIEW_ALL: Full entry data (default, backward-compatible)
 * - HIDE_PASSWORD: Hides sensitive fields (password, CVV, account numbers, etc.)
 * - OVERVIEW_ONLY: Identifying fields only (title + type-specific summary fields)
 */
export const SHARE_PERMISSION = {
  VIEW_ALL: "VIEW_ALL",
  HIDE_PASSWORD: "HIDE_PASSWORD",
  OVERVIEW_ONLY: "OVERVIEW_ONLY",
} as const;

export type SharePermissionValue =
  (typeof SHARE_PERMISSION)[keyof typeof SHARE_PERMISSION];

export const SHARE_PERMISSION_VALUES = [
  SHARE_PERMISSION.VIEW_ALL,
  SHARE_PERMISSION.HIDE_PASSWORD,
  SHARE_PERMISSION.OVERVIEW_ONLY,
] as const;

// ─── Entry-type-aware field definitions ─────────────────────

import type { EntryTypeValue } from "./entry-type";

/**
 * Sensitive fields to remove per entry type for HIDE_PASSWORD.
 * `customFields` is included because custom fields may contain
 * password-type values that should not leak through HIDE_PASSWORD.
 */
export const SENSITIVE_FIELDS: Readonly<Record<EntryTypeValue, ReadonlySet<string>>> = {
  LOGIN:            new Set(["password", "customFields"]),
  SECURE_NOTE:      new Set(["content", "customFields"]),
  CREDIT_CARD:      new Set(["cardNumber", "cvv", "customFields"]),
  IDENTITY:         new Set(["idNumber", "customFields"]),
  PASSKEY:          new Set(["credentialId", "customFields"]),
  // swiftBic is intentionally excluded: it is a public financial institution
  // identifier (like a bank's routing code) and not sensitive on its own.
  BANK_ACCOUNT:     new Set(["accountNumber", "routingNumber", "iban", "customFields"]),
  SOFTWARE_LICENSE:  new Set(["licenseKey", "customFields"]),
};

/** Fields to keep per entry type for OVERVIEW_ONLY. */
export const OVERVIEW_FIELDS: Readonly<Record<EntryTypeValue, ReadonlySet<string>>> = {
  LOGIN:            new Set(["title", "username", "url"]),
  SECURE_NOTE:      new Set(["title"]),
  CREDIT_CARD:      new Set(["title", "cardholderName", "brand", "expiryMonth", "expiryYear"]),
  IDENTITY:         new Set(["title", "fullName", "email"]),
  PASSKEY:          new Set(["title", "username", "relyingPartyName"]),
  BANK_ACCOUNT:     new Set(["title", "bankName", "accountType", "accountHolderName"]),
  SOFTWARE_LICENSE:  new Set(["title", "softwareName", "version", "licensee"]),
};

// Fallback for unknown entry types (LOGIN-compatible, defensive copies)
const DEFAULT_SENSITIVE: ReadonlySet<string> = new Set(SENSITIVE_FIELDS.LOGIN);
const DEFAULT_OVERVIEW: ReadonlySet<string> = new Set(OVERVIEW_FIELDS.LOGIN);

/**
 * Apply share permissions to plaintext data before encryption.
 * Returns a filtered copy of the data.
 *
 * @param data - The plaintext entry data
 * @param permissions - Permission levels to apply
 * @param entryType - Entry type for type-specific filtering.
 *   Accepts `string` for caller convenience (Prisma models may pass wider types).
 *   Unknown values fall back to LOGIN-compatible defaults via `||` operator.
 */
export function applySharePermissions(
  data: Record<string, unknown>,
  permissions: string[],
  entryType?: string,
): Record<string, unknown> {
  if (permissions.length === 0 || permissions.includes(SHARE_PERMISSION.VIEW_ALL)) {
    return { ...data };
  }

  if (permissions.includes(SHARE_PERMISSION.OVERVIEW_ONLY)) {
    const allowedFields = (entryType && OVERVIEW_FIELDS[entryType as EntryTypeValue]) || DEFAULT_OVERVIEW;
    const filtered: Record<string, unknown> = {};
    for (const key of allowedFields) {
      if (key in data) filtered[key] = data[key];
    }
    return filtered;
  }

  if (permissions.includes(SHARE_PERMISSION.HIDE_PASSWORD)) {
    const sensitiveFields = (entryType && SENSITIVE_FIELDS[entryType as EntryTypeValue]) || DEFAULT_SENSITIVE;
    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (!sensitiveFields.has(key)) {
        filtered[key] = value;
      }
    }
    return filtered;
  }

  // Fail-closed: unrecognized permission values → apply OVERVIEW_ONLY (most restrictive)
  const allowedFields = (entryType && OVERVIEW_FIELDS[entryType as EntryTypeValue]) || DEFAULT_OVERVIEW;
  const filtered: Record<string, unknown> = {};
  for (const key of allowedFields) {
    if (key in data) filtered[key] = data[key];
  }
  return filtered;
}
