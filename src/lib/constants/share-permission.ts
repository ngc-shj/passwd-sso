/**
 * Share permission levels.
 *
 * - VIEW_ALL: Full entry data (default, backward-compatible)
 * - HIDE_PASSWORD: Hides password/CVV fields
 * - OVERVIEW_ONLY: Title, username, URL only
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

/** Fields to remove for HIDE_PASSWORD permission. */
const HIDE_PASSWORD_FIELDS = new Set([
  "password",
  "cvv",
]);

/** Fields to keep for OVERVIEW_ONLY permission. */
const OVERVIEW_ONLY_FIELDS = new Set([
  "title",
  "username",
  "url",
]);

/**
 * Apply share permissions to plaintext data before encryption.
 * Returns a filtered copy of the data.
 */
export function applySharePermissions(
  data: Record<string, unknown>,
  permissions: string[],
): Record<string, unknown> {
  if (permissions.length === 0 || permissions.includes(SHARE_PERMISSION.VIEW_ALL)) {
    return data;
  }

  if (permissions.includes(SHARE_PERMISSION.OVERVIEW_ONLY)) {
    const filtered: Record<string, unknown> = {};
    for (const key of OVERVIEW_ONLY_FIELDS) {
      if (key in data) filtered[key] = data[key];
    }
    return filtered;
  }

  if (permissions.includes(SHARE_PERMISSION.HIDE_PASSWORD)) {
    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (!HIDE_PASSWORD_FIELDS.has(key)) {
        filtered[key] = value;
      }
    }
    return filtered;
  }

  return data;
}
