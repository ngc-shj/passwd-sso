/**
 * Confirmation phrases the user must type verbatim before destructive
 * vault operations. Centralized so server/client/tests share a single source
 * of truth (T12 / N5 — replaces ~23 occurrences of literal "DELETE MY VAULT").
 */
export const VAULT_CONFIRMATION_PHRASE = {
  DELETE_VAULT: "DELETE MY VAULT",
  APPROVE: "APPROVE",
} as const;

export type VaultConfirmationPhrase =
  (typeof VAULT_CONFIRMATION_PHRASE)[keyof typeof VAULT_CONFIRMATION_PHRASE];
