export const GRANT_STATUS = {
  ACTIVE: "active",
  EXPIRED: "expired",
  REVOKED: "revoked",
} as const;

export type GrantStatus = (typeof GRANT_STATUS)[keyof typeof GRANT_STATUS];
