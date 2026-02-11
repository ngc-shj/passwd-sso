export const VAULT_STATUS = {
  LOADING: "loading",
  LOCKED: "locked",
  UNLOCKED: "unlocked",
  SETUP_REQUIRED: "setup-required",
} as const;

export type VaultStatus = (typeof VAULT_STATUS)[keyof typeof VAULT_STATUS];
