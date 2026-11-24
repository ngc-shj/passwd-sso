export const VAULT_STATUS = {
  LOADING: "loading",
  LOCKED: "locked",
  UNLOCKED: "unlocked",
  SETUP_REQUIRED: "setup-required",
} as const;

export type VaultStatus = (typeof VAULT_STATUS)[keyof typeof VAULT_STATUS];

// A brand-new vault's first personal key version. Client setup installs it and
// the setup route stores it, so both sides must agree; every later version is
// threaded from the live key (see scripts/checks/check-crypto-domains.mjs Check E).
export const INITIAL_VAULT_KEY_VERSION = 1;
