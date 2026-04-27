import { MS_PER_MINUTE } from "../time";

export const OPERATOR_TOKEN_PREFIX = "op_" as const;

export const OPERATOR_TOKEN_SCOPE = {
  MAINTENANCE: "maintenance",
} as const satisfies Record<string, string>;

export type OperatorTokenScope =
  (typeof OPERATOR_TOKEN_SCOPE)[keyof typeof OPERATOR_TOKEN_SCOPE];

/** Throttle interval for lastUsedAt updates (ms) */
export const OPERATOR_TOKEN_LAST_USED_THROTTLE_MS = 5 * MS_PER_MINUTE;

export const OPERATOR_TOKEN_PLAINTEXT_RE: RegExp =
  /^op_[A-Za-z0-9_-]{43}$/;

/** Default operator token expiry: 30 days */
export const OPERATOR_TOKEN_DEFAULT_EXPIRES_DAYS = 30;

/** Maximum operator token expiry: 90 days */
export const OPERATOR_TOKEN_MAX_EXPIRES_DAYS = 90;

/** Minimum operator token expiry: 1 day */
export const OPERATOR_TOKEN_MIN_EXPIRES_DAYS = 1;

/** Maximum length for operator-supplied token name label */
export const OPERATOR_TOKEN_NAME_MAX_LENGTH = 128;
