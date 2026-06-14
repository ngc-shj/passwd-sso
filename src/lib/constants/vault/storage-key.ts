export const LOCAL_STORAGE_KEY = {
  WATCHTOWER_LAST_ANALYZED_AT: "watchtower:lastAnalyzedAt",
  RECOVERY_KEY_BANNER_DISMISSED: "psso:recovery-key-banner-dismissed",
} as const;

export type LocalStorageKey = (typeof LOCAL_STORAGE_KEY)[keyof typeof LOCAL_STORAGE_KEY];

export const SESSION_STORAGE_KEY = {
  WEBAUTHN_SIGNIN: "psso:webauthn-signin",
  SHARE_ACCESS_PREFIX: "share-access:",
} as const;

export type SessionStorageKey = (typeof SESSION_STORAGE_KEY)[keyof typeof SESSION_STORAGE_KEY];

